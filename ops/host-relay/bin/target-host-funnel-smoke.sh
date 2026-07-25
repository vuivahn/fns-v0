#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Disposable acceptance test for the loopback-only Funnel edge. Tailscale itself
# is deliberately not required here: the test sends PROXY protocol v2 directly
# to exercise the exact backend boundary that Funnel uses.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile_directory="$(cd -- "${script_directory}/.." && pwd)"
source "${script_directory}/common.sh"

readonly SMOKE_CONFIRMATION="I_UNDERSTAND_THIS_IS_NONPRODUCTION"
readonly SMOKE_RUNTIME_UID=10001
readonly SMOKE_RUNTIME_GID=10001

require_root
require_command chmod chown date docker env find grep head install od openssl realpath rm sed seq sha256sum sleep sort timeout tr
require_runtime_configuration
require_var FNS_RELAY_SMOKE_ROOT FNS_RELAY_SMOKE_CONFIRM FNS_RELAY_EDGE_IMAGE FNS_RELAY_NODE_IMAGE
[[ "$FNS_RELAY_SMOKE_CONFIRM" == "$SMOKE_CONFIRMATION" ]] \
  || fail "set FNS_RELAY_SMOKE_CONFIRM=${SMOKE_CONFIRMATION} to acknowledge non-production publication"
require_safe_absolute_path FNS_RELAY_SMOKE_ROOT

compose_file="${FNS_RELAY_FUNNEL_COMPOSE_FILE:-${profile_directory}/compose.funnel.yaml}"
require_safe_absolute_path compose_file
require_existing_file "$compose_file"
proxy_client="${script_directory}/funnel-proxy-client.js"
require_existing_file "$proxy_client"
smoke_root="$(realpath --canonicalize-missing "$FNS_RELAY_SMOKE_ROOT")"
evidence_directory="$(realpath --canonicalize-missing "${FNS_RELAY_FUNNEL_SMOKE_EVIDENCE_DIR:-${smoke_root}/funnel-evidence}")"
require_safe_absolute_path evidence_directory

paths_overlap() {
  local left="$1" right="$2"
  [[ "$left" == "$right" || "$left" == "${right}/"* || "$right" == "${left}/"* ]]
}

for production_path in \
  "$FNS_RELAY_CANDIDATE_DIR" \
  "$FNS_RELAY_BLOB_DIR" \
  "$FNS_RELAY_CAPABILITY_DIR" \
  "$FNS_RELAY_SECRETS_DIR" \
  "$FNS_RELAY_ARCHIVE_STAGING_DIR" \
  "$FNS_RELAY_VERIFIED_ARCHIVE_DIR" \
  "$FNS_RELAY_EVIDENCE_DIR" \
  "$FNS_RELAY_DRILL_ROOT"; do
  canonical_production_path="$(realpath --canonicalize-missing "$production_path")"
  paths_overlap "$smoke_root" "$canonical_production_path" \
    && fail "FNS_RELAY_SMOKE_ROOT must not overlap production path: ${canonical_production_path}"
  paths_overlap "$evidence_directory" "$canonical_production_path" \
    && fail "FNS_RELAY_FUNNEL_SMOKE_EVIDENCE_DIR must not overlap production path: ${canonical_production_path}"
done

random_port() {
  local value
  value="$(od -An -N 2 -tu2 /dev/urandom | tr --delete ' ')"
  printf '%s' "$((20000 + value % 20000))"
}

edge_port="${FNS_RELAY_FUNNEL_SMOKE_EDGE_PORT:-$(random_port)}"
[[ "$edge_port" =~ ^[1-9][0-9]*$ && "$edge_port" -ge 1024 && "$edge_port" -le 65535 ]] \
  || fail "FNS_RELAY_FUNNEL_SMOKE_EDGE_PORT must be an unprivileged TCP port"
run_id="funnel-smoke-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$"
run_root="${smoke_root}/runs/${run_id}"
[[ "$run_root" == "${smoke_root}/runs/"* ]] || fail "unsafe Funnel smoke run path"
environment_file="${run_root}/compose.env"
relay_container="fns-relay-${run_id}"
edge_container="fns-relay-funnel-edge-${run_id}"
compose_project="fns-relay-funnel-${run_id}"
started_at="$(utc_now)"
result_status="failed"
compose_started=false
result_file="${evidence_directory}/${run_id}.json"

finish() {
  local exit_code="$1" checks='{}'
  if [[ "$compose_started" == true ]]; then
    smoke_compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ "$result_status" == success ]]; then
    checks='{"nonRoot":true,"readOnlyRootfs":true,"loopbackOnly":true,"proxyProtocol":true,"publication":true,"pagination":true,"restart":true,"archive":true}'
  fi
  install --directory --owner root --group root --mode 0700 "$evidence_directory"
  printf '{"kind":"target-host-funnel-smoke","status":"%s","startedAt":"%s","finishedAt":"%s","run":"%s","architecture":"linux/amd64","checks":%s}\n' \
    "$result_status" "$started_at" "$(utc_now)" "$run_id" "$checks" >"$result_file"
  rm --recursive --force -- "$run_root"
  exit "$exit_code"
}
trap 'exit_code=$?; trap - EXIT; finish "$exit_code"' EXIT

smoke_compose() {
  env --ignore-environment \
    "PATH=$PATH" \
    "HOME=${HOME:-/root}" \
    "DOCKER_HOST=${DOCKER_HOST:-}" \
    "DOCKER_CONFIG=${DOCKER_CONFIG:-}" \
    docker compose \
    --project-name "$compose_project" \
    --env-file "$environment_file" \
    --file "$compose_file" \
    "$@"
}

relay_internal_status() {
  local pathname="$1"
  timeout 5s docker exec --user "${SMOKE_RUNTIME_UID}:${SMOKE_RUNTIME_GID}" "$relay_container" node -e '
const http = require("http");
const pathname = process.argv[1];
const request = http.get({ host: "127.0.0.1", port: 8080, path: pathname }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on("error", () => process.exit(1));
request.setTimeout(2000, () => {
  request.destroy();
  process.exit(1);
});
' "$pathname"
}

wait_for_relay_ready() {
  local deadline="$(($(date +%s) + 60))"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if relay_internal_status /readyz; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 100 "$relay_container" >&2 || true
  fail "Funnel smoke Relay did not become ready"
}

container_path() {
  local filename="$1" canonical
  canonical="$(realpath --canonicalize-existing "$filename")"
  [[ "$canonical" == "${run_root}/"* ]] || fail "Funnel smoke request file escaped run root"
  printf '/work/%s' "${canonical#"${run_root}/"}"
}

funnel_edge_request() {
  local method="$1" pathname="$2" output="$3" body_file="${4:-}" authorization_file="${5:-}"
  local -a arguments=(--port "$edge_port" --method "$method" --path "$pathname")
  if [[ -n "$body_file" ]]; then arguments+=(--body-file "$(container_path "$body_file")"); fi
  if [[ -n "$authorization_file" ]]; then arguments+=(--authorization-file "$(container_path "$authorization_file")"); fi
  # The probe mounts a root-only disposable request directory so that the
  # bearer fixture cannot become host-world-readable. It has no Relay data
  # mount, a read-only root filesystem, no Linux capabilities, and only reads
  # its explicit request files.
  docker run --rm --network host --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges=true \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
    --mount "type=bind,source=${proxy_client},target=/funnel-proxy-client.js,readonly" \
    --mount "type=bind,source=${run_root},target=/work,readonly" \
    --entrypoint node "$FNS_RELAY_IMAGE" /funnel-proxy-client.js "${arguments[@]}" >"$output"
  sed --quiet '1{s/\r$//;s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p;}' "$output"
}

wait_for_edge_ready() {
  local deadline="$(($(date +%s) + 60))" status
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if status="$(funnel_edge_request GET /healthz "${responses_directory}/edge-wait.raw" 2>/dev/null || true)" && [[ "$status" == 404 ]]; then
      return 0
    fi
    sleep 1
  done
  docker inspect --format '{{json .State}}' "$edge_container" >&2 || true
  docker logs --tail 100 "$edge_container" >&2 || true
  fail "Funnel smoke edge did not become ready"
}

admin_capability() {
  docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
    --mount "type=bind,source=${capabilities_directory},target=/var/lib/fns-relay/capabilities" \
    --mount "type=bind,source=${secrets_directory},target=/run/secrets,readonly" \
    --env FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper \
    --entrypoint node "$FNS_RELAY_IMAGE" relay-v1/apps/public-relay/bin/admin.js "$@"
}

make_secret() {
  local target="$1"
  od -An -N 48 -tx1 /dev/urandom | tr --delete ' \n' >"$target"
  chown "root:${SMOKE_RUNTIME_GID}" "$target"
  chmod 0440 "$target"
}

make_object_id() {
  local digest
  digest="$(printf '%s' "${run_id}:$1" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr --delete '=')"
  [[ "$digest" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "could not derive a canonical Funnel smoke ObjectId"
  printf 'fns:obj:sha256:%s' "$digest"
}

install --directory --owner root --group root --mode 0700 "$smoke_root" "$smoke_root/runs" "$evidence_directory"
install --directory --owner root --group root --mode 0700 "$run_root"
candidates_directory="${run_root}/candidates"
blobs_directory="${run_root}/blobs"
capabilities_directory="${run_root}/capabilities"
secrets_directory="${run_root}/secrets"
archive_staging_directory="${run_root}/archive-staging"
verified_archive_directory="${run_root}/verified-archive"
smoke_evidence_directory="${run_root}/evidence"
drill_root="${run_root}/drills"
responses_directory="${run_root}/responses"
for directory in "$candidates_directory" "$blobs_directory" "$capabilities_directory"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0750 "$directory"
done
for directory in "$archive_staging_directory" "$verified_archive_directory"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0700 "$directory"
done
install --directory --owner root --group "$SMOKE_RUNTIME_GID" --mode 0710 "$secrets_directory"
for directory in "$smoke_evidence_directory" "$drill_root" "$responses_directory"; do
  install --directory --owner root --group root --mode 0700 "$directory"
done
make_secret "${secrets_directory}/capability-pepper"
make_secret "${secrets_directory}/cursor-secret"
install --mode 0600 "${FNS_RELAY_EVIDENCE_DIR}/current-image-build.json" "${smoke_evidence_directory}/current-image-build.json"

{
  printf '%s\n' "FNS_RELAY_IMAGE=${FNS_RELAY_IMAGE}"
  printf '%s\n' "FNS_RELAY_EDGE_IMAGE=${FNS_RELAY_EDGE_IMAGE}"
  printf '%s\n' "FNS_RELAY_RELAY_CONTAINER_NAME=${relay_container}"
  printf '%s\n' "FNS_RELAY_FUNNEL_EDGE_CONTAINER_NAME=${edge_container}"
  printf '%s\n' 'FNS_RELAY_FUNNEL_EDGE_BIND=127.0.0.1'
  printf '%s\n' "FNS_RELAY_FUNNEL_EDGE_PORT=${edge_port}"
  printf '%s\n' 'FNS_RELAY_FUNNEL_PUBLIC_PORT=8443'
  printf '%s\n' "FNS_RELAY_CANDIDATE_DIR=${candidates_directory}"
  printf '%s\n' "FNS_RELAY_BLOB_DIR=${blobs_directory}"
  printf '%s\n' "FNS_RELAY_CAPABILITY_DIR=${capabilities_directory}"
  printf '%s\n' "FNS_RELAY_SECRETS_DIR=${secrets_directory}"
  printf '%s\n' "FNS_RELAY_ARCHIVE_STAGING_DIR=${archive_staging_directory}"
  printf '%s\n' "FNS_RELAY_VERIFIED_ARCHIVE_DIR=${verified_archive_directory}"
  printf '%s\n' "FNS_RELAY_EVIDENCE_DIR=${smoke_evidence_directory}"
  printf '%s\n' "FNS_RELAY_DRILL_ROOT=${drill_root}"
} >"$environment_file"
chmod 0600 "$environment_file"

bash "${script_directory}/verify-image.sh"
[[ "$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Architecture}}')" == amd64 ]] \
  || fail "Funnel target-host smoke currently requires a linux/amd64 Relay image"
smoke_compose up --detach
compose_started=true
[[ "$(docker inspect "$relay_container" --format '{{.Config.User}}')" == "10001:10001" ]] \
  || fail "Funnel smoke Relay is not configured to run as UID/GID 10001"
[[ "$(docker inspect "$relay_container" --format '{{.HostConfig.ReadonlyRootfs}}')" == true ]] \
  || fail "Funnel smoke Relay root filesystem is not read-only"
private_network="${compose_project}_relay"
relay_networks="$(docker inspect "$relay_container" --format '{{json .NetworkSettings.Networks}}')"
edge_networks="$(docker inspect "$edge_container" --format '{{json .NetworkSettings.Networks}}')"
[[ "$relay_networks" == *"\"${private_network}\":"* ]] || fail "Funnel smoke Relay must use the private network"
[[ "$edge_networks" == *"\"${private_network}\":"* ]] || fail "Funnel smoke edge must use the private network"
[[ -z "$(docker port "$relay_container" 8080/tcp 2>/dev/null || true)" ]] \
  || fail "Funnel smoke Relay must not publish port 8080 to the host"
edge_port_bindings="$(docker inspect "$edge_container" --format '{{json .HostConfig.PortBindings}}')"
[[ "$edge_port_bindings" == *"\"8080/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"${edge_port}\"}"* ]] \
  || fail "Funnel smoke edge must publish only its loopback port"
wait_for_relay_ready
relay_internal_status /healthz
wait_for_edge_ready
[[ "$(funnel_edge_request GET /healthz "${responses_directory}/edge-health.raw")" == 404 ]] \
  || fail "Funnel edge must not expose /healthz"
[[ "$(funnel_edge_request GET /readyz "${responses_directory}/edge-ready.raw")" == 404 ]] \
  || fail "Funnel edge must not expose /readyz"

issued="$(admin_capability issue-capability "$(( $(date +%s) + 600 ))" relay:publication:create)"
token="$(printf '%s\n' "$issued" | sed --quiet 's/.*"token":"\([^"]*\)".*/\1/p')"
token_id="$(printf '%s\n' "$issued" | sed --quiet 's/.*"id":"\([^"]*\)".*/\1/p')"
[[ "$token" =~ ^fnsr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || fail "capability issuance returned no bearer token"
[[ "$token_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail "capability issuance returned no capability ID"
token_file="${responses_directory}/publication.token"
printf '%s' "$token" >"$token_file"
chmod 0600 "$token_file"

context_id="$(make_object_id context)"
binding_a="$(make_object_id binding-a)"
binding_b="$(make_object_id binding-b)"
alias="funnel-smoke-${run_id}"
printf '{"objectId":"%s","object":{"payload":{"type":"fns.alias.bind","context":"%s","alias":"%s"}}}\n' \
  "$binding_a" "$context_id" "$alias" >"${responses_directory}/publish-a.json"
printf '{"objectId":"%s","object":{"payload":{"type":"fns.alias.bind","context":"%s","alias":"%s"}}}\n' \
  "$binding_b" "$context_id" "$alias" >"${responses_directory}/publish-b.json"
for request_file in "${responses_directory}/publish-a.json" "${responses_directory}/publish-b.json"; do
  [[ "$(funnel_edge_request POST /v1/publications "${request_file}.response" "$request_file" "$token_file")" == 201 ]] \
    || fail "Funnel smoke publication did not return HTTP 201"
done
admin_capability revoke-capability "$token_id" >/dev/null
rm --force -- "$token_file"

page_one="${responses_directory}/page-one.raw"
page_two="${responses_directory}/page-two.raw"
[[ "$(funnel_edge_request GET "/v1/discovery/alias-bindings?context=${context_id}&alias=${alias}&limit=1" "$page_one")" == 200 ]] \
  || fail "first Funnel anonymous discovery page did not return HTTP 200"
grep --quiet '"nextCursor"' "$page_one" || fail "first Funnel discovery page did not include a cursor"
cursor="$(sed --quiet 's/.*"nextCursor":"\([^"]*\)".*/\1/p' "$page_one")"
[[ -n "$cursor" ]] || fail "first Funnel discovery page had an empty cursor"
[[ "$(funnel_edge_request GET "/v1/discovery/alias-bindings?context=${context_id}&alias=${alias}&limit=1&cursor=${cursor}" "$page_two")" == 200 ]] \
  || fail "second Funnel anonymous discovery page did not return HTTP 200"
grep --quiet '"complete":true' "$page_two" || fail "second Funnel discovery page was not complete"

smoke_compose stop --timeout 12 relay
[[ "$(docker inspect "$relay_container" --format '{{.State.ExitCode}}')" == 0 ]] \
  || fail "Funnel smoke Relay did not exit cleanly after SIGTERM"
smoke_compose up --detach --no-deps relay
wait_for_relay_ready
[[ "$(funnel_edge_request GET "/v1/objects/${binding_a}" "${responses_directory}/restart-object.raw")" == 200 ]] \
  || fail "candidate/blob did not survive Funnel Relay restart"

env \
  "FNS_RELAY_CANDIDATE_DIR=${candidates_directory}" \
  "FNS_RELAY_BLOB_DIR=${blobs_directory}" \
  "FNS_RELAY_CAPABILITY_DIR=${capabilities_directory}" \
  "FNS_RELAY_SECRETS_DIR=${secrets_directory}" \
  "FNS_RELAY_ARCHIVE_STAGING_DIR=${archive_staging_directory}" \
  "FNS_RELAY_VERIFIED_ARCHIVE_DIR=${verified_archive_directory}" \
  "FNS_RELAY_EVIDENCE_DIR=${smoke_evidence_directory}" \
  "FNS_RELAY_DRILL_ROOT=${drill_root}" \
  bash "${script_directory}/archive.sh" >/dev/null
smoke_manifest="$(find "$verified_archive_directory" -maxdepth 1 -type f -name 'relay-*.manifest.json' -printf '%T@ %p\n' \
  | sort --numeric-sort --reverse | head --lines 1 | cut --delimiter=' ' --fields=2-)"
[[ -n "$smoke_manifest" ]] || fail "Funnel smoke archive did not create a verified manifest"
require_existing_file "${verified_archive_directory}/$(archive_name_from_manifest "$smoke_manifest")"

result_status="success"
printf 'target-host Funnel smoke completed; evidence: %s\n' "$result_file"
