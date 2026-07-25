#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Send a small, credential-free failure event to an operator-owned HTTPS
# receiver. The destination URL and optional bearer token live in separate
# root-only files, not in relay.env or a command line.

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command cat chmod curl date grep hostname mktemp mv rm systemctl tr
require_var FNS_RELAY_EVIDENCE_DIR FNS_RELAY_ALERT_WEBHOOK_URL_FILE
require_safe_absolute_path FNS_RELAY_EVIDENCE_DIR FNS_RELAY_ALERT_WEBHOOK_URL_FILE
require_existing_directory "$FNS_RELAY_EVIDENCE_DIR"
require_existing_file "$FNS_RELAY_ALERT_WEBHOOK_URL_FILE"

unit="${1:-}"
[[ "$unit" =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || fail "alert target unit is invalid"

started_at="$(utc_now)"
evidence_file="${FNS_RELAY_EVIDENCE_DIR}/alert-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$.json"
temporary_evidence="${evidence_file}.tmp"
payload_file=""
curl_configuration=""
delivery="failed"

safe_value() {
  local value="$1"
  if [[ "$value" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    printf '%s' "$value"
  else
    printf '%s' unknown
  fi
}

finish() {
  local exit_code="$1"
  set +e
  printf '{"kind":"failure-alert","status":"%s","createdAt":"%s","unit":"%s","delivery":"%s"}\n' \
    "$([[ "$delivery" == delivered ]] && printf success || printf failed)" \
    "$started_at" "$unit" "$delivery" >"$temporary_evidence"
  chmod 0600 "$temporary_evidence"
  mv -- "$temporary_evidence" "$evidence_file"
  [[ -z "$payload_file" ]] || rm --force -- "$payload_file"
  [[ -z "$curl_configuration" ]] || rm --force -- "$curl_configuration"
  exit "$exit_code"
}
trap 'exit_code=$?; trap - EXIT; finish "$exit_code"' EXIT

webhook_url="$(tr --delete '\r\n' <"$FNS_RELAY_ALERT_WEBHOOK_URL_FILE")"
printf '%s\n' "$webhook_url" | grep --extended-regexp --quiet '^https://[^[:space:]"\\]+$' \
  || fail "FNS_RELAY_ALERT_WEBHOOK_URL_FILE must contain one HTTPS URL without quotes or whitespace"

timeout_seconds="${FNS_RELAY_ALERT_TIMEOUT_SECONDS:-15}"
[[ "$timeout_seconds" =~ ^([1-9]|[1-9][0-9]|1[01][0-9]|120)$ ]] \
  || fail "FNS_RELAY_ALERT_TIMEOUT_SECONDS must be between 1 and 120"

bearer_token=""
if [[ -n "${FNS_RELAY_ALERT_WEBHOOK_BEARER_TOKEN_FILE:-}" ]]; then
  require_safe_absolute_path FNS_RELAY_ALERT_WEBHOOK_BEARER_TOKEN_FILE
  require_existing_file "$FNS_RELAY_ALERT_WEBHOOK_BEARER_TOKEN_FILE"
  bearer_token="$(tr --delete '\r\n' <"$FNS_RELAY_ALERT_WEBHOOK_BEARER_TOKEN_FILE")"
  printf '%s\n' "$bearer_token" | grep --extended-regexp --quiet '^[A-Za-z0-9._~-]{1,4096}$' \
    || fail "alert bearer token file has an unsupported format"
fi

host="$(safe_value "$(hostname)")"
active_state="$(safe_value "$(systemctl show "$unit" --property ActiveState --value 2>/dev/null || true)")"
sub_state="$(safe_value "$(systemctl show "$unit" --property SubState --value 2>/dev/null || true)")"
result="$(safe_value "$(systemctl show "$unit" --property Result --value 2>/dev/null || true)")"
main_status="$(safe_value "$(systemctl show "$unit" --property ExecMainStatus --value 2>/dev/null || true)")"

umask 077
payload_file="$(mktemp "${FNS_RELAY_EVIDENCE_DIR}/.alert-payload.XXXXXX")"
curl_configuration="$(mktemp "${FNS_RELAY_EVIDENCE_DIR}/.alert-curl.XXXXXX")"
printf '{"kind":"fns-relay-alert","version":1,"status":"failure","observedAt":"%s","host":"%s","unit":"%s","activeState":"%s","subState":"%s","result":"%s","execMainStatus":"%s"}\n' \
  "$(utc_now)" "$host" "$unit" "$active_state" "$sub_state" "$result" "$main_status" >"$payload_file"
{
  printf 'url = "%s"\n' "$webhook_url"
  printf 'header = "Content-Type: application/json"\n'
  if [[ -n "$bearer_token" ]]; then printf 'header = "Authorization: Bearer %s"\n' "$bearer_token"; fi
} >"$curl_configuration"
chmod 0600 "$payload_file" "$curl_configuration"

curl --config "$curl_configuration" --fail --silent --show-error --max-time "$timeout_seconds" \
  --request POST --data-binary "@${payload_file}" --output /dev/null
delivery="delivered"
printf 'delivered failure alert for %s\n' "$unit"
