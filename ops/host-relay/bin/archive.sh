#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command docker flock install sed sha256sum
require_runtime_configuration
require_var FNS_RELAY_NODE_IMAGE
bash "${script_directory}/verify-image.sh" --relay-only
require_existing_directory \
  "$FNS_RELAY_CANDIDATE_DIR" \
  "$FNS_RELAY_BLOB_DIR" \
  "$FNS_RELAY_ARCHIVE_STAGING_DIR" \
  "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" \
  "$FNS_RELAY_EVIDENCE_DIR"

exec 9>"${FNS_RELAY_EVIDENCE_DIR}/archive.lock"
flock --nonblock 9 || fail "another archive operation is already running"

stamp="$(utc_compact)"
archive_name="relay-${stamp}.json"
staged_archive="${FNS_RELAY_ARCHIVE_STAGING_DIR}/${archive_name}"
verified_archive="${FNS_RELAY_VERIFIED_ARCHIVE_DIR}/${archive_name}"
staged_checksum="${staged_archive}.sha256"
verified_checksum="${verified_archive}.sha256"
staged_manifest="${FNS_RELAY_ARCHIVE_STAGING_DIR}/relay-${stamp}.manifest.json"
verified_manifest="${FNS_RELAY_VERIFIED_ARCHIVE_DIR}/relay-${stamp}.manifest.json"

for filename in "$staged_archive" "$verified_archive" "$staged_checksum" "$verified_checksum" "$staged_manifest" "$verified_manifest"; do
  [[ ! -e "$filename" ]] || fail "refusing to overwrite existing archive artifact: ${filename}"
done

export_result="$(
  docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
    --mount "type=bind,source=${FNS_RELAY_CANDIDATE_DIR},target=/var/lib/fns-relay/candidates,readonly" \
    --mount "type=bind,source=${FNS_RELAY_BLOB_DIR},target=/var/lib/fns-relay/blobs,readonly" \
    --mount "type=bind,source=${FNS_RELAY_ARCHIVE_STAGING_DIR},target=/archive" \
    --entrypoint node "$FNS_RELAY_IMAGE" relay-v1/apps/public-relay/bin/admin.js export "/archive/${archive_name}"
)"
archive_digest="$(printf '%s\n' "$export_result" | sed --quiet 's/.*"digest":"\([A-Za-z0-9_-]\{43\}\)".*/\1/p')"
[[ "$archive_digest" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "archive export did not return a valid contract digest"

docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${FNS_RELAY_CANDIDATE_DIR},target=/var/lib/fns-relay/candidates,readonly" \
  --mount "type=bind,source=${FNS_RELAY_BLOB_DIR},target=/var/lib/fns-relay/blobs,readonly" \
  --entrypoint node "$FNS_RELAY_IMAGE" relay-v1/apps/public-relay/bin/admin.js verify >/dev/null

archive_validation="$(
  docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
    --mount "type=bind,source=${FNS_RELAY_ARCHIVE_STAGING_DIR},target=/archive,readonly" \
    --entrypoint node "$FNS_RELAY_IMAGE" relay-v1/apps/public-relay/bin/admin.js verify-archive "/archive/${archive_name}"
)"
validated_digest="$(printf '%s\n' "$archive_validation" | sed --quiet 's/.*"digest":"\([A-Za-z0-9_-]\{43\}\)".*/\1/p')"
[[ "$validated_digest" == "$archive_digest" ]] || fail "archive-only verification returned a different digest"

raw_sha256="$(sha256_of "$staged_archive")"
printf '%s  %s\n' "$raw_sha256" "$archive_name" >"$staged_checksum"
image_id="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Id}}')"
source_offer="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
[[ "$source_offer" =~ ^https://github\.com/vuivahn/fns-v0/archive/[0-9a-f]{40}\.tar\.gz$ ]] \
  || fail "Relay image has no valid immutable source offer label"
[[ "$FNS_RELAY_NODE_IMAGE" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "FNS_RELAY_NODE_IMAGE must be an immutable image digest"
printf '{"version":1,"createdAt":"%s","archive":"%s","archiveDigest":"%s","sha256":"%s","imageId":"%s","sourceOffer":"%s","nodeImage":"%s"}\n' \
  "$(utc_now)" "$archive_name" "$archive_digest" "$raw_sha256" "$image_id" "$source_offer" "$FNS_RELAY_NODE_IMAGE" >"$staged_manifest"

mv -- "$staged_archive" "$verified_archive"
mv -- "$staged_checksum" "$verified_checksum"
mv -- "$staged_manifest" "$verified_manifest"
printf 'verified archive %s (%s)\n' "$verified_archive" "$archive_digest"
