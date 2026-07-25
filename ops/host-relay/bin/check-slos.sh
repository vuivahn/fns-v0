#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_command curl cut find head sed sort stat
require_runtime_configuration
require_var FNS_RELAY_PROBE_PORT
require_existing_directory "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" "$FNS_RELAY_EVIDENCE_DIR"

latest_by_name() {
  local pattern="$1"
  find "$FNS_RELAY_EVIDENCE_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' \
    | sort --numeric-sort --reverse \
    | head --lines 1 \
    | cut --delimiter=' ' --fields=2-
}

age_seconds() {
  local filename="$1"
  printf '%s' "$(( $(date +%s) - $(stat --format %Y "$filename") ))"
}

manifest="$(latest_verified_manifest)"
[[ -n "$manifest" ]] || fail "no verified archive exists"
archive_age="$(age_seconds "$manifest")"
[[ "$archive_age" -le 3600 ]] || fail "latest verified archive is older than one hour (${archive_age}s)"

off_provider_receipt="$(latest_by_name 'off-provider-*.json')"
[[ -n "$off_provider_receipt" ]] || fail "no off-provider copy receipt exists"
off_provider_age="$(age_seconds "$off_provider_receipt")"
[[ "$off_provider_age" -le 86400 ]] || fail "latest off-provider receipt is older than 24 hours (${off_provider_age}s)"

restore_receipt="$(latest_by_name 'restore-*.json')"
[[ -n "$restore_receipt" ]] || fail "no restore drill evidence exists"
restore_status="$(sed --quiet 's/.*"status":"\([^"]*\)".*/\1/p' "$restore_receipt")"
[[ "$restore_status" == "success" ]] || fail "latest restore drill did not succeed"
restore_age="$(age_seconds "$restore_receipt")"
[[ "$restore_age" -le 604800 ]] || fail "latest restore drill is older than seven days (${restore_age}s)"

curl --fail --silent --show-error --output /dev/null "http://127.0.0.1:${FNS_RELAY_PROBE_PORT}/readyz"
printf '{"kind":"slo-check","checkedAt":"%s","archiveAgeSeconds":%s,"offProviderAgeSeconds":%s,"restoreAgeSeconds":%s,"restoreStatus":"%s"}\n' \
  "$(utc_now)" "$archive_age" "$off_provider_age" "$restore_age" "$restore_status"
