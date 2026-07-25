#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command cat rclone sha256sum install
require_runtime_configuration
require_var FNS_RELAY_RCLONE_CONFIG FNS_RELAY_OFF_PROVIDER_REMOTE
require_safe_absolute_path FNS_RELAY_RCLONE_CONFIG
require_existing_file "$FNS_RELAY_RCLONE_CONFIG"
require_existing_directory "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" "$FNS_RELAY_EVIDENCE_DIR"

manifest="$(latest_verified_manifest)"
[[ -n "$manifest" ]] || fail "no verified archive manifest is available"
archive_name="$(archive_name_from_manifest "$manifest")"
[[ "$archive_name" =~ ^relay-[0-9]{8}T[0-9]{6}Z\.json$ ]] || fail "verified manifest has an invalid archive name"
archive="${FNS_RELAY_VERIFIED_ARCHIVE_DIR}/${archive_name}"
checksum="${archive}.sha256"
require_existing_file "$archive" "$checksum" "$manifest"

read -r expected_sha256 _ <"$checksum"
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "archive checksum file is invalid"
[[ "$(sha256_of "$archive")" == "$expected_sha256" ]] || fail "source archive checksum does not match"

export RCLONE_CONFIG="$FNS_RELAY_RCLONE_CONFIG"
remote_prefix="${FNS_RELAY_OFF_PROVIDER_REMOTE%/}"
for artifact in "$archive" "$checksum" "$manifest"; do
  rclone copyto --immutable "$artifact" "${remote_prefix}/$(basename -- "$artifact")"
done
remote_sha256="$(rclone cat "${remote_prefix}/${archive_name}" | sha256sum | awk '{print $1}')"
[[ "$remote_sha256" == "$expected_sha256" ]] || fail "off-provider archive checksum does not match"
[[ "$(rclone cat "${remote_prefix}/$(basename -- "$checksum")")" == "$(cat "$checksum")" ]] \
  || fail "off-provider checksum artifact does not match"
remote_manifest_sha256="$(rclone cat "${remote_prefix}/$(basename -- "$manifest")" | sha256sum | awk '{print $1}')"
[[ "$remote_manifest_sha256" == "$(sha256_of "$manifest")" ]] || fail "off-provider manifest does not match"

receipt="${FNS_RELAY_EVIDENCE_DIR}/off-provider-$(utc_compact).json"
printf '{"kind":"off-provider-copy","createdAt":"%s","archive":"%s","sha256":"%s"}\n' \
  "$(utc_now)" "$archive_name" "$expected_sha256" >"$receipt"
rclone copyto --immutable "$receipt" "${remote_prefix}/receipts/$(basename -- "$receipt")"
[[ "$(rclone cat "${remote_prefix}/receipts/$(basename -- "$receipt")" | sha256sum | awk '{print $1}')" == "$(sha256_of "$receipt")" ]] \
  || fail "off-provider receipt does not match"
printf 'verified off-provider copy of %s\n' "$archive_name"
