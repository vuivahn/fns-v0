#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command curl docker install od rclone sed seq sha256sum tar tr
require_runtime_configuration
require_var FNS_RELAY_RCLONE_CONFIG FNS_RELAY_OFF_PROVIDER_REMOTE
require_safe_absolute_path FNS_RELAY_RCLONE_CONFIG
require_existing_file "$FNS_RELAY_RCLONE_CONFIG"
require_existing_directory "$FNS_RELAY_EVIDENCE_DIR" "$FNS_RELAY_DRILL_ROOT"

receipt_sha256=""
if [[ -n "${FNS_RELAY_RESTORE_ARCHIVE_NAME:-}" ]]; then
  archive_name="$FNS_RELAY_RESTORE_ARCHIVE_NAME"
else
  receipt="$(latest_off_provider_receipt)"
  [[ -n "$receipt" ]] || fail "no off-provider copy receipt is available; set FNS_RELAY_RESTORE_ARCHIVE_NAME for a recovery host"
  archive_name="$(archive_name_from_manifest "$receipt")"
  receipt_sha256="$(archive_sha256_from_manifest "$receipt")"
  [[ "$receipt_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "off-provider receipt has an invalid archive checksum"
fi
[[ "$archive_name" =~ ^relay-[0-9]{8}T[0-9]{6}Z\.json$ ]] || fail "restore archive name is invalid"

started_epoch="$(date +%s)"
run_id="restore-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$"
run_root="${FNS_RELAY_DRILL_ROOT}/${run_id}"
archive_directory="${run_root}/archive"
candidates_directory="${run_root}/candidates"
blobs_directory="${run_root}/blobs"
capabilities_directory="${run_root}/capabilities"
secrets_directory="${run_root}/secrets"
container_name="fns-relay-${run_id}"
evidence_file="${FNS_RELAY_EVIDENCE_DIR}/${run_id}.json"
drill_status="failed"
object_read="not-attempted"
recovery_image=""

finish() {
  local exit_code="$1"
  local ended_epoch elapsed
  ended_epoch="$(date +%s)"
  elapsed="$((ended_epoch - started_epoch))"
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  if [[ -n "$recovery_image" ]]; then docker image rm --force "$recovery_image" >/dev/null 2>&1 || true; fi
  printf '{"kind":"restore-drill","status":"%s","createdAt":"%s","archive":"%s","elapsedSeconds":%s,"objectRead":"%s"}\n' \
    "$drill_status" "$(utc_now)" "$archive_name" "$elapsed" "$object_read" >"$evidence_file"
  exit "$exit_code"
}
trap 'exit_code=$?; trap - EXIT; finish "$exit_code"' EXIT

install --directory --owner root --group root --mode 0700 "$run_root"
install --directory --owner root --group "$FNS_RELAY_RUNTIME_GID" --mode 0750 "$archive_directory"
for directory in "$candidates_directory" "$blobs_directory" "$capabilities_directory"; do
  install --directory --owner "$FNS_RELAY_RUNTIME_UID" --group "$FNS_RELAY_RUNTIME_GID" --mode 0700 "$directory"
done
install --directory --owner root --group "$FNS_RELAY_RUNTIME_GID" --mode 0710 "$secrets_directory"

export RCLONE_CONFIG="$FNS_RELAY_RCLONE_CONFIG"
remote_prefix="${FNS_RELAY_OFF_PROVIDER_REMOTE%/}"
for artifact in "$archive_name" "${archive_name}.sha256" "${archive_name%.json}.manifest.json"; do
  rclone copyto "${remote_prefix}/${artifact}" "${archive_directory}/${artifact}"
  chown "root:${FNS_RELAY_RUNTIME_GID}" "${archive_directory}/${artifact}"
  chmod 0440 "${archive_directory}/${artifact}"
done

read -r expected_sha256 _ <"${archive_directory}/${archive_name}.sha256"
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "downloaded checksum file is invalid"
if [[ -n "$receipt_sha256" ]]; then
  [[ "$expected_sha256" == "$receipt_sha256" ]] || fail "downloaded checksum does not match the off-provider receipt"
fi
[[ "$(sha256_of "${archive_directory}/${archive_name}")" == "$expected_sha256" ]] || fail "downloaded archive checksum does not match"

downloaded_manifest="${archive_directory}/${archive_name%.json}.manifest.json"
[[ "$(archive_name_from_manifest "$downloaded_manifest")" == "$archive_name" ]] \
  || fail "downloaded manifest has a different archive name"
[[ "$(archive_sha256_from_manifest "$downloaded_manifest")" == "$expected_sha256" ]] \
  || fail "downloaded manifest has a different archive checksum"
expected_digest="$(archive_digest_from_manifest "$downloaded_manifest")"
[[ "$expected_digest" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "downloaded manifest has an invalid archive digest"
source_offer="$(source_offer_from_manifest "$downloaded_manifest")"
[[ "$source_offer" =~ ^https://github\.com/vuivahn/fns-v0/archive/[0-9a-f]{40}\.tar\.gz$ ]] \
  || fail "downloaded manifest has an invalid source offer"
node_image="$(node_image_from_manifest "$downloaded_manifest")"
[[ "$node_image" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "downloaded manifest has an invalid Node image digest"
source_directory="${run_root}/source"
recovery_image="fns-relay-recovery-${run_id}"
install --directory --owner root --group root --mode 0700 "$source_directory"
curl --fail --silent --show-error --location "$source_offer" \
  | tar --extract --gzip --strip-components=1 --directory "$source_directory"
docker build \
  --file "${source_directory}/Dockerfile.relay" \
  --tag "$recovery_image" \
  --build-arg "NODE_IMAGE=${node_image}" \
  --build-arg "FNS_RELAY_SOURCE_OFFER_URL=${source_offer}" \
  "$source_directory" >/dev/null
actual_source_offer="$(docker image inspect "$recovery_image" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
[[ "$actual_source_offer" == "$source_offer" ]] || fail "recovered Relay image source offer does not match the archived deployment"

archive_validation="$(
  docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${archive_directory},target=/archive,readonly" \
  --entrypoint node "$recovery_image" relay-v1/apps/public-relay/bin/admin.js verify-archive "/archive/${archive_name}"
)"
archive_digest="$(printf '%s\n' "$archive_validation" | sed --quiet 's/.*"digest":"\([A-Za-z0-9_-]\{43\}\)".*/\1/p')"
[[ "$archive_digest" == "$expected_digest" ]] || fail "archive-only verification returned a different digest"

docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${archive_directory},target=/archive,readonly" \
  --mount "type=bind,source=${candidates_directory},target=/var/lib/fns-relay/candidates" \
  --mount "type=bind,source=${blobs_directory},target=/var/lib/fns-relay/blobs" \
  --entrypoint node "$recovery_image" relay-v1/apps/public-relay/bin/admin.js restore-replace "/archive/${archive_name}" --confirm-replace >/dev/null

docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${candidates_directory},target=/var/lib/fns-relay/candidates,readonly" \
  --mount "type=bind,source=${blobs_directory},target=/var/lib/fns-relay/blobs,readonly" \
  --entrypoint node "$recovery_image" relay-v1/apps/public-relay/bin/admin.js verify >/dev/null

for secret_name in capability-pepper cursor-secret; do
  od -An -N 48 -tx1 /dev/urandom | tr --delete ' \n' >"${secrets_directory}/${secret_name}"
  chown "root:${FNS_RELAY_RUNTIME_GID}" "${secrets_directory}/${secret_name}"
  chmod 0440 "${secrets_directory}/${secret_name}"
done

docker run --detach --name "$container_name" "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --publish 127.0.0.1::8080 \
  --mount "type=bind,source=${candidates_directory},target=/var/lib/fns-relay/candidates" \
  --mount "type=bind,source=${blobs_directory},target=/var/lib/fns-relay/blobs" \
  --mount "type=bind,source=${capabilities_directory},target=/var/lib/fns-relay/capabilities" \
  --mount "type=bind,source=${secrets_directory},target=/run/secrets,readonly" \
  --env FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper \
  --env FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret \
  "$recovery_image" >/dev/null

port="$(docker port "$container_name" 8080/tcp | sed --quiet 's/.*:\([0-9][0-9]*\)$/\1/p')"
[[ "$port" =~ ^[0-9]+$ ]] || fail "could not determine temporary Relay port"
base_url="http://127.0.0.1:${port}"
ready=""
for _ in $(seq 1 60); do
  if ready="$(curl --fail --silent --show-error "${base_url}/readyz")"; then break; fi
  sleep 1
done
[[ -n "$ready" ]] || fail "restored Relay did not become ready"

read -r entry_count encoded_object_id < <(
  docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
    --mount "type=bind,source=${archive_directory},target=/archive,readonly" \
    --entrypoint node "$recovery_image" \
    -e "const fs=require('fs');const archive=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const entries=archive.candidateSnapshot.entries;process.stdout.write(String(entries.length)+' '+(entries[0]?encodeURIComponent(entries[0].objectId):'')+'\\n');" \
    "/archive/${archive_name}"
)
if [[ "$entry_count" -gt 0 ]]; then
  curl --fail --silent --show-error --output /dev/null "${base_url}/v1/objects/${encoded_object_id}"
  object_read="ok"
else
  object_read="skipped-empty-archive"
fi

elapsed_seconds="$(( $(date +%s) - started_epoch ))"
[[ "$elapsed_seconds" -lt 14400 ]] || fail "restore drill exceeded the four-hour RTO target"
drill_status="success"
printf 'restore drill completed in %s seconds; evidence: %s\n' "$elapsed_seconds" "$evidence_file"
