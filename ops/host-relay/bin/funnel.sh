#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_directory}/common.sh"

usage() {
  printf 'usage: %s {start|verify|stop}\n' "${0##*/}" >&2
  exit 2
}

[[ "$#" == 1 ]] || usage
action="$1"

require_command docker grep install mktemp sed tailscale
require_runtime_configuration
require_var FNS_RELAY_FUNNEL_EDGE_BIND FNS_RELAY_FUNNEL_EDGE_PORT FNS_RELAY_FUNNEL_PUBLIC_PORT
require_existing_directory "$FNS_RELAY_EVIDENCE_DIR"

[[ "$FNS_RELAY_FUNNEL_EDGE_BIND" == "127.0.0.1" ]] \
  || fail "FNS_RELAY_FUNNEL_EDGE_BIND must be exactly 127.0.0.1"
[[ "$FNS_RELAY_FUNNEL_EDGE_PORT" =~ ^[1-9][0-9]*$ && "$FNS_RELAY_FUNNEL_EDGE_PORT" -le 65535 ]] \
  || fail "FNS_RELAY_FUNNEL_EDGE_PORT must be a TCP port"
[[ "$FNS_RELAY_FUNNEL_PUBLIC_PORT" =~ ^(443|8443|10000)$ ]] \
  || fail "FNS_RELAY_FUNNEL_PUBLIC_PORT must be one of 443, 8443, or 10000"

readonly relay_container="${FNS_RELAY_RELAY_CONTAINER_NAME:-fns-relay}"
readonly edge_container="${FNS_RELAY_FUNNEL_EDGE_CONTAINER_NAME:-fns-relay-funnel-edge}"
readonly proxy_client="${script_directory}/funnel-proxy-client.js"
require_existing_file "$proxy_client"

relay_ready() {
  docker inspect --format '{{.State.Health.Status}}' "$relay_container" 2>/dev/null | grep --quiet '^healthy$' \
    || fail "Relay container is not healthy: ${relay_container}"
  docker exec --user "${FNS_RELAY_RUNTIME_UID}:${FNS_RELAY_RUNTIME_GID}" "$relay_container" node -e '
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
}

edge_status() {
  local pathname="$1" temporary status
  temporary="$(mktemp)"
  docker run --rm --network host --read-only --user "${FNS_RELAY_RUNTIME_UID}:${FNS_RELAY_RUNTIME_GID}" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
    --mount "type=bind,source=${proxy_client},target=/funnel-proxy-client.js,readonly" \
    --entrypoint node "$FNS_RELAY_IMAGE" /funnel-proxy-client.js \
    --port "$FNS_RELAY_FUNNEL_EDGE_PORT" --path "$pathname" >"$temporary"
  status="$(sed --quiet '1{s/\r$//;s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p;}' "$temporary")"
  rm --force -- "$temporary"
  [[ "$status" =~ ^[0-9]{3}$ ]] || fail "Funnel edge returned no HTTP status for ${pathname}"
  printf '%s' "$status"
}

verify_local_boundary() {
  local relay_ports edge_port_bindings edge_effective_port_bindings edge_ports
  relay_ready
  [[ "$(docker inspect --format '{{.State.Running}}' "$edge_container" 2>/dev/null)" == true ]] \
    || fail "Funnel edge is not running: ${edge_container}"
  relay_ports="$(docker port "$relay_container" 8080/tcp 2>/dev/null || true)"
  [[ -z "$relay_ports" ]] || fail "Relay must not publish port 8080 to the host"
  # Require both Docker's declared and effective bindings. A container attached
  # only to an internal network can retain the declaration without installing
  # a reachable host port.
  edge_port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$edge_container")"
  [[ "$edge_port_bindings" == *"\"8080/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"${FNS_RELAY_FUNNEL_EDGE_PORT}\"}"* ]] \
    || fail "Funnel edge must publish only 127.0.0.1:${FNS_RELAY_FUNNEL_EDGE_PORT}"
  edge_effective_port_bindings="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$edge_container")"
  [[ "$edge_effective_port_bindings" == *"\"8080/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"${FNS_RELAY_FUNNEL_EDGE_PORT}\"}"* ]] \
    || fail "Funnel edge loopback port is not effective"
  edge_ports="$(docker port "$edge_container" 8080/tcp 2>/dev/null || true)"
  [[ "$edge_ports" == "127.0.0.1:${FNS_RELAY_FUNNEL_EDGE_PORT}" ]] \
    || fail "Funnel edge must expose exactly one effective loopback port"
  [[ "$(edge_status /healthz)" == 404 ]] || fail "Funnel edge must hide /healthz"
  [[ "$(edge_status /readyz)" == 404 ]] || fail "Funnel edge must hide /readyz"
}

record_status() {
  local status_json record current temporary
  status_json="$(tailscale funnel status --json)"
  record="${FNS_RELAY_EVIDENCE_DIR}/funnel-$(utc_compact).json"
  current="${FNS_RELAY_EVIDENCE_DIR}/current-funnel.json"
  temporary="${current}.$$"
  printf '%s\n' "$status_json" >"$record"
  chmod 0600 "$record"
  printf '%s\n' "$status_json" >"$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$current"
  printf '%s\n' "$record"
}

case "$action" in
  start)
    verify_local_boundary
    tailscale funnel --bg --yes --proxy-protocol=2 --tls-terminated-tcp="$FNS_RELAY_FUNNEL_PUBLIC_PORT" \
      "tcp://127.0.0.1:${FNS_RELAY_FUNNEL_EDGE_PORT}"
    record_status >/dev/null
    ;;
  verify)
    verify_local_boundary
    record_status
    ;;
  stop)
    tailscale funnel --proxy-protocol=2 --tls-terminated-tcp="$FNS_RELAY_FUNNEL_PUBLIC_PORT" off
    ;;
  *)
    usage
    ;;
esac
