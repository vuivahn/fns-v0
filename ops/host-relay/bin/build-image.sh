#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command curl docker git install
require_var FNS_RELAY_IMAGE FNS_RELAY_NODE_IMAGE FNS_RELAY_SOURCE_DIR FNS_RELAY_EVIDENCE_DIR
require_safe_absolute_path FNS_RELAY_SOURCE_DIR FNS_RELAY_EVIDENCE_DIR
require_existing_directory "$FNS_RELAY_SOURCE_DIR"
[[ "$FNS_RELAY_NODE_IMAGE" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "FNS_RELAY_NODE_IMAGE must be a reviewed immutable image digest"
[[ "$FNS_RELAY_NODE_IMAGE" != *"@sha256:0000000000000000000000000000000000000000000000000000000000000000" ]] \
  || fail "FNS_RELAY_NODE_IMAGE still has the example placeholder digest"

[[ -z "$(git -C "$FNS_RELAY_SOURCE_DIR" status --porcelain)" ]] || fail "source checkout must be clean"
revision="$(git -C "$FNS_RELAY_SOURCE_DIR" rev-parse HEAD)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "source checkout must resolve to a full lowercase Git revision"
source_offer="https://github.com/vuivahn/fns-v0/archive/${revision}.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --head "$source_offer" >/dev/null

build_arguments=(
  --file "${FNS_RELAY_SOURCE_DIR}/Dockerfile.relay"
  --tag "$FNS_RELAY_IMAGE"
  --build-arg "FNS_RELAY_SOURCE_OFFER_URL=${source_offer}"
  --build-arg "NODE_IMAGE=${FNS_RELAY_NODE_IMAGE}"
)
docker build "${build_arguments[@]}" "$FNS_RELAY_SOURCE_DIR"

actual_offer="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
[[ "$actual_offer" == "$source_offer" ]] || fail "built image source label does not match its immutable source offer"
image_id="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Id}}')"
install --directory --owner root --group root --mode 0700 "$FNS_RELAY_EVIDENCE_DIR"
build_record="${FNS_RELAY_EVIDENCE_DIR}/image-build-${revision}.json"
current_record="${FNS_RELAY_EVIDENCE_DIR}/current-image-build.json"
printf '{"kind":"image-build","createdAt":"%s","revision":"%s","image":"%s","imageId":"%s","sourceOffer":"%s","nodeImage":"%s"}\n' \
  "$(utc_now)" "$revision" "$FNS_RELAY_IMAGE" "$image_id" "$source_offer" "$FNS_RELAY_NODE_IMAGE" \
  >"$build_record"
chmod 0600 "$build_record"
temporary_record="${current_record}.$$"
printf '{"kind":"image-build","createdAt":"%s","revision":"%s","image":"%s","imageId":"%s","sourceOffer":"%s","nodeImage":"%s"}\n' \
  "$(utc_now)" "$revision" "$FNS_RELAY_IMAGE" "$image_id" "$source_offer" "$FNS_RELAY_NODE_IMAGE" >"$temporary_record"
chmod 0600 "$temporary_record"
mv -- "$temporary_record" "$current_record"
printf 'built %s from %s (%s)\n' "$FNS_RELAY_IMAGE" "$revision" "$image_id"
