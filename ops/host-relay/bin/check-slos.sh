#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command cat chmod cut date docker find head mv sed sort stat timeout tr
require_runtime_configuration
require_var FNS_RELAY_ACTIVE_PROFILE
require_existing_directory "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" "$FNS_RELAY_EVIDENCE_DIR"

case "$FNS_RELAY_ACTIVE_PROFILE" in
  direct) ;;
  funnel) bash "${script_directory}/funnel.sh" verify >/dev/null ;;
  *) fail "FNS_RELAY_ACTIVE_PROFILE must be direct or funnel" ;;
esac

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

relay_container="${FNS_RELAY_RELAY_CONTAINER_NAME:-fns-relay}"
relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$relay_container" 2>/dev/null)" \
  || fail "Relay container is not inspectable: ${relay_container}"
[[ "$relay_health" == healthy ]] || fail "Relay container is not healthy: ${relay_health}"
timeout 5s docker exec --user "${FNS_RELAY_RUNTIME_UID}:${FNS_RELAY_RUNTIME_GID}" "$relay_container" node -e '
const http = require("http");
const request = http.get({ host: "127.0.0.1", port: 8080, path: "/readyz" }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on("error", () => process.exit(1));
request.setTimeout(2000, () => {
  request.destroy();
  process.exit(1);
});
' || fail "Relay container is not ready"

evidence_file="${FNS_RELAY_EVIDENCE_DIR}/slo-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$.json"
temporary_evidence="${evidence_file}.tmp"
printf '{"kind":"slo-check","status":"success","checkedAt":"%s","archiveAgeSeconds":%s,"offProviderAgeSeconds":%s,"restoreAgeSeconds":%s,"restoreStatus":"%s","relayHealth":"%s"}\n' \
  "$(utc_now)" "$archive_age" "$off_provider_age" "$restore_age" "$restore_status" "$relay_health" >"$temporary_evidence"
chmod 0600 "$temporary_evidence"
mv -- "$temporary_evidence" "$evidence_file"
cat "$evidence_file"
