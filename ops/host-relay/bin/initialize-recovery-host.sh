#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command install
require_recovery_configuration

for directory in "$FNS_RELAY_EVIDENCE_DIR" "$FNS_RELAY_DRILL_ROOT"; do
  install --directory --owner root --group root --mode 0700 "$directory"
done
