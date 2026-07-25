#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Bootstrap only the deliberately limited home-server Funnel beta. It is for a
# trusted account that already has Docker access, which is effectively
# host-root-equivalent. All mutable paths must live below one explicit runtime
# root so the Docker ownership helper cannot accidentally touch host paths.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

readonly BETA_CONFIRMATION="I_UNDERSTAND_HOME_FUNNEL_BETA_IS_NOT_SLO_COMPLIANT"

require_command chmod chown curl docker git install od realpath sed tr
require_runtime_configuration
require_var FNS_RELAY_HOME_BETA_CONFIRM FNS_RELAY_HOME_BETA_ROOT FNS_RELAY_NODE_IMAGE FNS_RELAY_EDGE_IMAGE FNS_RELAY_SOURCE_DIR
[[ "$FNS_RELAY_HOME_BETA_CONFIRM" == "$BETA_CONFIRMATION" ]] \
  || fail "set FNS_RELAY_HOME_BETA_CONFIRM=${BETA_CONFIRMATION} to acknowledge beta-only recovery limits"
require_safe_absolute_path FNS_RELAY_HOME_BETA_ROOT FNS_RELAY_SOURCE_DIR
require_existing_directory "$FNS_RELAY_SOURCE_DIR"
[[ "$FNS_RELAY_NODE_IMAGE" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "FNS_RELAY_NODE_IMAGE must be a reviewed immutable image digest"
[[ "$FNS_RELAY_EDGE_IMAGE" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "FNS_RELAY_EDGE_IMAGE must be a reviewed immutable image digest"
[[ "$FNS_RELAY_NODE_IMAGE" != *"@sha256:0000000000000000000000000000000000000000000000000000000000000000" ]] \
  || fail "FNS_RELAY_NODE_IMAGE still has the example placeholder digest"
[[ "$FNS_RELAY_EDGE_IMAGE" != *"@sha256:0000000000000000000000000000000000000000000000000000000000000000" ]] \
  || fail "FNS_RELAY_EDGE_IMAGE still has the example placeholder digest"

beta_root="$(realpath --canonicalize-missing "$FNS_RELAY_HOME_BETA_ROOT")"
require_safe_absolute_path beta_root
[[ "$beta_root" != / ]] || fail "FNS_RELAY_HOME_BETA_ROOT must not be /"

# A successful run deliberately makes Relay data service-owned and secrets
# root-owned. Re-running as the ordinary home-server operator must therefore
# not attempt a host chmod on existing directories; later, narrowly-scoped
# Docker helpers enforce the service-owned paths they are responsible for.
ensure_directory() {
  local directory="$1" mode="$2"
  if [[ -d "$directory" ]]; then return 0; fi
  [[ ! -e "$directory" ]] || fail "expected a directory but found another path: ${directory}"
  install --directory --mode "$mode" "$directory"
}

ensure_operator_private_directory() {
  local directory="$1"
  ensure_directory "$directory" 0700
  chmod 0700 "$directory" || fail "operator must retain control of beta directory: ${directory}"
}

for configured_path in \
  "$FNS_RELAY_CANDIDATE_DIR" \
  "$FNS_RELAY_BLOB_DIR" \
  "$FNS_RELAY_CAPABILITY_DIR" \
  "$FNS_RELAY_SECRETS_DIR" \
  "$FNS_RELAY_ARCHIVE_STAGING_DIR" \
  "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" \
  "$FNS_RELAY_EVIDENCE_DIR" \
  "$FNS_RELAY_DRILL_ROOT"; do
  canonical_path="$(realpath --canonicalize-missing "$configured_path")"
  [[ "$canonical_path" == "${beta_root}/"* ]] \
    || fail "all beta runtime paths must stay below FNS_RELAY_HOME_BETA_ROOT: ${canonical_path}"
done

[[ -z "$(git -C "$FNS_RELAY_SOURCE_DIR" status --porcelain)" ]] || fail "source checkout must be clean"
revision="$(git -C "$FNS_RELAY_SOURCE_DIR" rev-parse HEAD)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "source checkout must resolve to a full lowercase Git revision"
source_offer="https://github.com/vuivahn/fns-v0/archive/${revision}.tar.gz"
curl --fail --silent --show-error --location --head "$source_offer" >/dev/null

ensure_directory "$beta_root" 0700
for directory in "$FNS_RELAY_CANDIDATE_DIR" "$FNS_RELAY_BLOB_DIR" "$FNS_RELAY_CAPABILITY_DIR"; do
  ensure_directory "$directory" 0750
done
for directory in "$FNS_RELAY_ARCHIVE_STAGING_DIR" "$FNS_RELAY_VERIFIED_ARCHIVE_DIR"; do
  ensure_directory "$directory" 0700
done
ensure_directory "$FNS_RELAY_SECRETS_DIR" 0700
ensure_operator_private_directory "$FNS_RELAY_EVIDENCE_DIR"
ensure_operator_private_directory "$FNS_RELAY_DRILL_ROOT"

capability_pepper="${FNS_RELAY_SECRETS_DIR}/capability-pepper"
cursor_secret="${FNS_RELAY_SECRETS_DIR}/cursor-secret"
if [[ ! -e "$capability_pepper" && ! -e "$cursor_secret" ]]; then
  umask 077
  od -An -N 48 -tx1 /dev/urandom | tr --delete ' \n' >"$capability_pepper"
  od -An -N 48 -tx1 /dev/urandom | tr --delete ' \n' >"$cursor_secret"
elif [[ ! -f "$capability_pepper" || ! -f "$cursor_secret" ]]; then
  fail "both Relay secret files must exist together; refusing a partial secret reset"
fi

docker pull "$FNS_RELAY_NODE_IMAGE" >/dev/null
docker pull "$FNS_RELAY_EDGE_IMAGE" >/dev/null
docker build \
  --file "${FNS_RELAY_SOURCE_DIR}/Dockerfile.relay" \
  --tag "$FNS_RELAY_IMAGE" \
  --build-arg "FNS_RELAY_SOURCE_OFFER_URL=${source_offer}" \
  --build-arg "NODE_IMAGE=${FNS_RELAY_NODE_IMAGE}" \
  "$FNS_RELAY_SOURCE_DIR"
actual_offer="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
[[ "$actual_offer" == "$source_offer" ]] || fail "built image source label does not match its immutable source offer"
image_id="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Id}}')"

# Docker access is already a privileged boundary. Limit these helpers to each
# declared beta path, remove network access, and grant only the file-owner
# capabilities required to make the non-root service and secret mount usable.
set_service_directory_owner() {
  local directory="$1" mode="$2"
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges=true \
    --mount "type=bind,source=${directory},target=/target" \
    --entrypoint /bin/sh "$FNS_RELAY_IMAGE" -ec "chown 10001:10001 /target && chmod ${mode} /target"
}

for directory in "$FNS_RELAY_CANDIDATE_DIR" "$FNS_RELAY_BLOB_DIR" "$FNS_RELAY_CAPABILITY_DIR"; do
  set_service_directory_owner "$directory" 0750
done
for directory in "$FNS_RELAY_ARCHIVE_STAGING_DIR" "$FNS_RELAY_VERIFIED_ARCHIVE_DIR"; do
  set_service_directory_owner "$directory" 0700
done
docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges=true \
  --mount "type=bind,source=${FNS_RELAY_SECRETS_DIR},target=/secrets" \
  --entrypoint /bin/sh "$FNS_RELAY_IMAGE" -ec '
chown 0:10001 /secrets
chmod 0710 /secrets
chown 0:10001 /secrets/capability-pepper /secrets/cursor-secret
chmod 0440 /secrets/capability-pepper /secrets/cursor-secret
'

ensure_operator_private_directory "$FNS_RELAY_EVIDENCE_DIR"
build_record="${FNS_RELAY_EVIDENCE_DIR}/image-build-${revision}.json"
current_record="${FNS_RELAY_EVIDENCE_DIR}/current-image-build.json"
if [[ -e "$build_record" ]]; then
  recorded_image_id="$(sed --quiet 's/.*"imageId":"\([^"]*\)".*/\1/p' "$build_record")"
  [[ "$recorded_image_id" == "$image_id" ]] \
    || fail "existing beta build record names a different image ID: ${build_record}"
else
  printf '{"kind":"home-funnel-beta-image-build","createdAt":"%s","revision":"%s","image":"%s","imageId":"%s","sourceOffer":"%s","nodeImage":"%s","recoveryClass":"not-slo-compliant"}\n' \
    "$(utc_now)" "$revision" "$FNS_RELAY_IMAGE" "$image_id" "$source_offer" "$FNS_RELAY_NODE_IMAGE" >"$build_record"
  chmod 0600 "$build_record"
fi
temporary_record="${current_record}.$$"
install --mode 0600 "$build_record" "$temporary_record"
chmod 0600 "$temporary_record"
mv -- "$temporary_record" "$current_record"
printf 'bootstrapped home Funnel beta image %s from %s (%s)\n' "$FNS_RELAY_IMAGE" "$revision" "$image_id"
