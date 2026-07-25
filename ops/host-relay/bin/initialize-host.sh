#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command install
require_runtime_configuration

for directory in "$FNS_RELAY_CANDIDATE_DIR" "$FNS_RELAY_BLOB_DIR" "$FNS_RELAY_CAPABILITY_DIR"; do
  install --directory --owner "$FNS_RELAY_RUNTIME_UID" --group "$FNS_RELAY_RUNTIME_GID" --mode 0750 "$directory"
done
for directory in "$FNS_RELAY_ARCHIVE_STAGING_DIR" "$FNS_RELAY_VERIFIED_ARCHIVE_DIR"; do
  install --directory --owner "$FNS_RELAY_RUNTIME_UID" --group "$FNS_RELAY_RUNTIME_GID" --mode 0700 "$directory"
done
for directory in "$FNS_RELAY_EVIDENCE_DIR" "$FNS_RELAY_DRILL_ROOT"; do
  install --directory --owner root --group root --mode 0700 "$directory"
done
install --directory --owner root --group "$FNS_RELAY_RUNTIME_GID" --mode 0710 "$FNS_RELAY_SECRETS_DIR"

for secret_name in capability-pepper cursor-secret; do
  if [[ ! -f "${FNS_RELAY_SECRETS_DIR}/${secret_name}" ]]; then
    printf 'provision %s through the selected secret manager before starting Relay\n' "${FNS_RELAY_SECRETS_DIR}/${secret_name}"
  fi
done
