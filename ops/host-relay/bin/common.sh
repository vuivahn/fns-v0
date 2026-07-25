#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -o nounset
set -o pipefail

export LC_ALL=C

readonly FNS_RELAY_RUNTIME_UID=10001
readonly FNS_RELAY_RUNTIME_GID=10001
readonly -a FNS_RELAY_HARDENED_ARGS=(
  --read-only
  --user "${FNS_RELAY_RUNTIME_UID}:${FNS_RELAY_RUNTIME_GID}"
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m
  --cap-drop ALL
  --security-opt no-new-privileges=true
  --pids-limit 128
)

fail() {
  printf 'fns-relay host automation: %s\n' "$*" >&2
  exit 1
}

require_var() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || fail "${name} must be set"
  done
}

require_command() {
  local command
  for command in "$@"; do
    command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: ${command}"
  done
}

require_root() {
  [[ "$(id --user)" == "0" ]] || fail "this operation must run as root"
}

require_safe_absolute_path() {
  local name value
  for name in "$@"; do
    require_var "$name"
    value="${!name}"
    [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ && "$value" != "/" ]] || fail "${name} must be a simple absolute path"
  done
}

require_existing_directory() {
  local directory
  for directory in "$@"; do
    [[ -d "$directory" ]] || fail "required directory is missing: ${directory}"
  done
}

require_existing_file() {
  local filename
  for filename in "$@"; do
    [[ -f "$filename" ]] || fail "required file is missing: ${filename}"
  done
}

require_runtime_configuration() {
  require_var \
    FNS_RELAY_IMAGE \
    FNS_RELAY_CANDIDATE_DIR \
    FNS_RELAY_BLOB_DIR \
    FNS_RELAY_CAPABILITY_DIR \
    FNS_RELAY_SECRETS_DIR \
    FNS_RELAY_ARCHIVE_STAGING_DIR \
    FNS_RELAY_VERIFIED_ARCHIVE_DIR \
    FNS_RELAY_EVIDENCE_DIR \
    FNS_RELAY_DRILL_ROOT
  require_safe_absolute_path \
    FNS_RELAY_CANDIDATE_DIR \
    FNS_RELAY_BLOB_DIR \
    FNS_RELAY_CAPABILITY_DIR \
    FNS_RELAY_SECRETS_DIR \
    FNS_RELAY_ARCHIVE_STAGING_DIR \
    FNS_RELAY_VERIFIED_ARCHIVE_DIR \
    FNS_RELAY_EVIDENCE_DIR \
    FNS_RELAY_DRILL_ROOT
}

utc_compact() {
  date --utc +%Y%m%dT%H%M%SZ
}

utc_now() {
  date --utc +%Y-%m-%dT%H:%M:%SZ
}

latest_verified_manifest() {
  find "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" -maxdepth 1 -type f -name 'relay-*.manifest.json' -printf '%T@ %p\n' \
    | sort --numeric-sort --reverse \
    | head --lines 1 \
    | cut --delimiter=' ' --fields=2-
}

latest_off_provider_receipt() {
  find "$FNS_RELAY_EVIDENCE_DIR" -maxdepth 1 -type f -name 'off-provider-*.json' -printf '%T@ %p\n' \
    | sort --numeric-sort --reverse \
    | head --lines 1 \
    | cut --delimiter=' ' --fields=2-
}

archive_name_from_manifest() {
  local manifest="$1"
  sed --quiet 's/.*"archive":"\([^"]*\)".*/\1/p' "$manifest"
}

archive_digest_from_manifest() {
  local manifest="$1"
  sed --quiet 's/.*"archiveDigest":"\([^"]*\)".*/\1/p' "$manifest"
}

archive_sha256_from_manifest() {
  local manifest="$1"
  sed --quiet 's/.*"sha256":"\([^"]*\)".*/\1/p' "$manifest"
}

source_offer_from_manifest() {
  local manifest="$1"
  sed --quiet 's/.*"sourceOffer":"\([^"]*\)".*/\1/p' "$manifest"
}

node_image_from_manifest() {
  local manifest="$1"
  sed --quiet 's/.*"nodeImage":"\([^"]*\)".*/\1/p' "$manifest"
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
}
