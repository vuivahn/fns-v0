#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Guard the serving units from accidentally starting the other transport
# profile against the same durable Relay data paths.

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_var FNS_RELAY_ACTIVE_PROFILE

expected_profile="${1:-}"
case "$expected_profile" in
  direct|funnel) ;;
  *) fail "expected profile must be direct or funnel" ;;
esac
case "$FNS_RELAY_ACTIVE_PROFILE" in
  direct|funnel) ;;
  *) fail "FNS_RELAY_ACTIVE_PROFILE must be direct or funnel" ;;
esac
[[ "$FNS_RELAY_ACTIVE_PROFILE" == "$expected_profile" ]] \
  || fail "configured active profile is ${FNS_RELAY_ACTIVE_PROFILE}, refusing to start ${expected_profile}"
