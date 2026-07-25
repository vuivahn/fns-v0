#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Run from a host outside the primary failure domain. It verifies the public
# source offer and one already-published anonymous object read; health endpoints
# deliberately remain private implementation details.

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command chmod curl date grep mktemp mv rm tr
require_var FNS_RELAY_EVIDENCE_DIR FNS_RELAY_PUBLIC_BASE_URL FNS_RELAY_PUBLIC_PROBE_OBJECT_ID
require_safe_absolute_path FNS_RELAY_EVIDENCE_DIR
require_existing_directory "$FNS_RELAY_EVIDENCE_DIR"

base_url="${FNS_RELAY_PUBLIC_BASE_URL%/}"
printf '%s\n' "$base_url" | grep --extended-regexp --quiet '^https://[^[:space:]"\\]+$' \
  || fail "FNS_RELAY_PUBLIC_BASE_URL must be one HTTPS URL without quotes or whitespace"
object_id="$FNS_RELAY_PUBLIC_PROBE_OBJECT_ID"
[[ "$object_id" =~ ^fns:obj:sha256:[A-Za-z0-9_-]{43}$ ]] \
  || fail "FNS_RELAY_PUBLIC_PROBE_OBJECT_ID must be an FNS object ID"

started_at="$(utc_now)"
evidence_file="${FNS_RELAY_EVIDENCE_DIR}/public-probe-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$.json"
temporary_evidence="${evidence_file}.tmp"
object_response=""
probe_status="failed"
source_offer="not-available"

finish() {
  local exit_code="$1"
  set +e
  printf '{"kind":"public-probe","status":"%s","checkedAt":"%s","baseUrl":"%s","sourceOffer":"%s","objectId":"%s"}\n' \
    "$probe_status" "$started_at" "$base_url" "$source_offer" "$object_id" >"$temporary_evidence"
  chmod 0600 "$temporary_evidence"
  mv -- "$temporary_evidence" "$evidence_file"
  [[ -z "$object_response" ]] || rm --force -- "$object_response"
  exit "$exit_code"
}
trap 'exit_code=$?; trap - EXIT; finish "$exit_code"' EXIT

source_offer="$(curl --fail --silent --show-error --noproxy '*' --proto '=https' --tlsv1.2 --max-time 20 \
  "${base_url}/.well-known/fns-source" | tr --delete '\r\n')"
[[ "$source_offer" =~ ^https://github\.com/vuivahn/fns-v0/archive/[0-9a-f]{40}\.tar\.gz$ ]] \
  || fail "public source offer is not an immutable FNS source archive"

umask 077
object_response="$(mktemp "${FNS_RELAY_EVIDENCE_DIR}/.public-probe-object.XXXXXX")"
curl --fail --silent --show-error --noproxy '*' --proto '=https' --tlsv1.2 --max-time 20 \
  --output "$object_response" "${base_url}/v1/objects/${object_id}"
grep --fixed-strings --quiet "\"objectId\":\"${object_id}\"" "$object_response" \
  || fail "anonymous object response did not contain the configured object ID"

probe_status="success"
printf 'public probe completed: %s\n' "$evidence_file"
