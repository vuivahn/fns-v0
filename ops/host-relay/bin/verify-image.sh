#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

require_root
require_command docker sed
require_runtime_configuration
require_var FNS_RELAY_NODE_IMAGE

# The archive job only reads candidate/blob data through the Relay image; it
# never starts the edge. Passing --relay-only skips the edge-image pin so an
# archive-only host is not forced to declare an image it will not use. The
# serving profiles invoke this script with no argument and require the edge.
if [[ "${1:-}" != "--relay-only" ]]; then
  require_var FNS_RELAY_EDGE_IMAGE
  [[ "$FNS_RELAY_EDGE_IMAGE" =~ ^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] \
    || fail "FNS_RELAY_EDGE_IMAGE must be a reviewed immutable image digest"
  [[ "$FNS_RELAY_EDGE_IMAGE" != *"@sha256:0000000000000000000000000000000000000000000000000000000000000000" ]] \
    || fail "FNS_RELAY_EDGE_IMAGE still has the example placeholder digest"
fi

build_record="${FNS_RELAY_EVIDENCE_DIR}/current-image-build.json"
require_existing_file "$build_record"
record_image="$(sed --quiet 's/.*"image":"\([^"]*\)".*/\1/p' "$build_record")"
record_image_id="$(sed --quiet 's/.*"imageId":"\([^"]*\)".*/\1/p' "$build_record")"
record_source_offer="$(source_offer_from_manifest "$build_record")"
record_node_image="$(node_image_from_manifest "$build_record")"
[[ "$record_image" == "$FNS_RELAY_IMAGE" ]] || fail "current image build record names a different Relay image"
[[ "$record_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "current image build record has an invalid image ID"
[[ "$record_source_offer" =~ ^https://github\.com/vuivahn/fns-v0/archive/[0-9a-f]{40}\.tar\.gz$ ]] \
  || fail "current image build record has an invalid source offer"
[[ "$record_node_image" == "$FNS_RELAY_NODE_IMAGE" ]] \
  || fail "current image build record uses a different Node image digest"

actual_image_id="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Id}}')"
actual_source_offer="$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
[[ "$actual_image_id" == "$record_image_id" ]] || fail "Relay image ID differs from the reviewed build record"
[[ "$actual_source_offer" == "$record_source_offer" ]] || fail "Relay image source offer differs from the reviewed build record"
