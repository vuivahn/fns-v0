#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# This is deliberately an opt-in, disposable host acceptance test. It never
# mounts or publishes into the configured production Relay paths.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile_directory="$(cd -- "${script_directory}/.." && pwd)"
source "${script_directory}/common.sh"

readonly SMOKE_CONFIRMATION="I_UNDERSTAND_THIS_IS_NONPRODUCTION"
readonly SMOKE_RUNTIME_UID=10001
readonly SMOKE_RUNTIME_GID=10001

require_root
require_command awk chmod chown curl cut date docker env find grep head install od openssl realpath rm sed seq sha256sum sleep sort timeout tr
require_runtime_configuration
require_var FNS_RELAY_SMOKE_ROOT FNS_RELAY_SMOKE_CONFIRM FNS_RELAY_EDGE_IMAGE FNS_RELAY_NODE_IMAGE
[[ "$FNS_RELAY_SMOKE_CONFIRM" == "$SMOKE_CONFIRMATION" ]] \
  || fail "set FNS_RELAY_SMOKE_CONFIRM=${SMOKE_CONFIRMATION} to acknowledge non-production publication"
require_safe_absolute_path FNS_RELAY_SMOKE_ROOT

compose_file="${FNS_RELAY_COMPOSE_FILE:-${profile_directory}/compose.yaml}"
require_safe_absolute_path compose_file
require_existing_file "$compose_file"
smoke_root="$(realpath --canonicalize-missing "$FNS_RELAY_SMOKE_ROOT")"
evidence_directory="$(realpath --canonicalize-missing "${FNS_RELAY_SMOKE_EVIDENCE_DIR:-${smoke_root}/evidence}")"
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
    && fail "FNS_RELAY_SMOKE_EVIDENCE_DIR must not overlap production path: ${canonical_production_path}"
done

random_port() {
  local value
  value="$(od -An -N 2 -tu2 /dev/urandom | tr --delete ' ')"
  printf '%s' "$((20000 + value % 20000))"
}

require_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ && "$value" -ge 1024 && "$value" -le 65535 ]] \
    || fail "${name} must be an unprivileged TCP port"
}

http_port="${FNS_RELAY_SMOKE_HTTP_PORT:-$(random_port)}"
https_port="${FNS_RELAY_SMOKE_HTTPS_PORT:-$(random_port)}"
require_port FNS_RELAY_SMOKE_HTTP_PORT "$http_port"
require_port FNS_RELAY_SMOKE_HTTPS_PORT "$https_port"
[[ "$http_port" != "$https_port" ]] || fail "smoke HTTP and HTTPS ports must be distinct"

smoke_domain="${FNS_RELAY_SMOKE_DOMAIN:-relay-host-smoke.invalid}"
[[ "$smoke_domain" =~ ^[A-Za-z0-9.-]+\.invalid$ ]] || fail "FNS_RELAY_SMOKE_DOMAIN must end in .invalid"
run_id="host-smoke-$(utc_compact | tr '[:upper:]' '[:lower:]')-$$"
run_root="${smoke_root}/runs/${run_id}"
[[ "$run_root" == "${smoke_root}/runs/"* ]] || fail "unsafe smoke run path"
environment_file="${run_root}/compose.env"
relay_container="fns-relay-${run_id}"
edge_container="fns-relay-edge-${run_id}"
restore_container="fns-relay-restored-${run_id}"
failure_container="fns-relay-permission-${run_id}"
compose_project="fns-relay-${run_id}"
started_at="$(utc_now)"
result_status="failed"
compose_started=false
curl_configuration="${run_root}/publish.curlrc"
result_file="${evidence_directory}/${run_id}.json"

finish() {
  local exit_code="$1" checks='{}'
  if [[ "$compose_started" == true ]]; then
    smoke_compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm --force "$restore_container" "$failure_container" >/dev/null 2>&1 || true
  rm --force -- "$curl_configuration" >/dev/null 2>&1 || true
  install --directory --owner root --group root --mode 0700 "$evidence_directory"
  if [[ "$result_status" == success ]]; then
    checks='{"nonRoot":true,"readOnlyRootfs":true,"edgeTls":true,"publication":true,"pagination":true,"restart":true,"archive":true,"freshRestore":true,"badPermissions":true}'
  fi
  printf '{"kind":"target-host-smoke","status":"%s","startedAt":"%s","finishedAt":"%s","run":"%s","architecture":"linux/amd64","checks":%s}\n' \
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
  fail "smoke Relay did not become ready"
}

edge_status() {
  local pathname="$1" output="$2"
  curl --silent --show-error --insecure --connect-timeout 2 --max-time 5 --noproxy '*' \
    --resolve "${smoke_domain}:${https_port}:127.0.0.1" \
    --output "$output" \
    --write-out '%{http_code}' \
    "https://${smoke_domain}:${https_port}${pathname}"
}

wait_for_edge_ready() {
  local deadline="$(($(date +%s) + 60))"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if [[ "$(edge_status /healthz "${responses_directory}/edge-wait.json" 2>/dev/null || true)" == "404" ]]; then
      return 0
    fi
    sleep 1
  done
  docker inspect --format '{{json .State}}' "$edge_container" >&2 || true
  docker logs --tail 100 "$edge_container" >&2 || true
  fail "smoke edge did not become ready"
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
  [[ "$digest" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "could not derive a canonical smoke ObjectId"
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
tls_directory="${run_root}/tls"
acme_directory="${run_root}/acme"
responses_directory="${run_root}/responses"
for directory in "$candidates_directory" "$blobs_directory" "$capabilities_directory"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0750 "$directory"
done
for directory in "$archive_staging_directory" "$verified_archive_directory"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0700 "$directory"
done
install --directory --owner root --group "$SMOKE_RUNTIME_GID" --mode 0710 "$secrets_directory"
for directory in "$smoke_evidence_directory" "$drill_root" "$tls_directory" "$acme_directory" "$responses_directory"; do
  install --directory --owner root --group root --mode 0700 "$directory"
done
make_secret "${secrets_directory}/capability-pepper"
make_secret "${secrets_directory}/cursor-secret"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=${smoke_domain}" \
  -addext "subjectAltName=DNS:${smoke_domain}" \
  -keyout "${tls_directory}/privkey.pem" \
  -out "${tls_directory}/fullchain.pem" >/dev/null 2>&1
chown "root:101" "${tls_directory}/privkey.pem" "${tls_directory}/fullchain.pem"
chmod 0440 "${tls_directory}/privkey.pem" "${tls_directory}/fullchain.pem"
chown "root:101" "$tls_directory" "$acme_directory"
chmod 0750 "$tls_directory" "$acme_directory"
install --mode 0600 "${FNS_RELAY_EVIDENCE_DIR}/current-image-build.json" "${smoke_evidence_directory}/current-image-build.json"

{
  printf '%s\n' "FNS_RELAY_IMAGE=${FNS_RELAY_IMAGE}"
  printf '%s\n' "FNS_RELAY_EDGE_IMAGE=${FNS_RELAY_EDGE_IMAGE}"
  printf '%s\n' "FNS_RELAY_DOMAIN=${smoke_domain}"
  printf '%s\n' "FNS_RELAY_RELAY_CONTAINER_NAME=${relay_container}"
  printf '%s\n' "FNS_RELAY_EDGE_CONTAINER_NAME=${edge_container}"
  printf '%s\n' "FNS_RELAY_EDGE_HTTP_BIND=127.0.0.1"
  printf '%s\n' "FNS_RELAY_EDGE_HTTP_PORT=${http_port}"
  printf '%s\n' "FNS_RELAY_EDGE_HTTPS_BIND=127.0.0.1"
  printf '%s\n' "FNS_RELAY_EDGE_HTTPS_PORT=${https_port}"
  printf '%s\n' "FNS_RELAY_CANDIDATE_DIR=${candidates_directory}"
  printf '%s\n' "FNS_RELAY_BLOB_DIR=${blobs_directory}"
  printf '%s\n' "FNS_RELAY_CAPABILITY_DIR=${capabilities_directory}"
  printf '%s\n' "FNS_RELAY_SECRETS_DIR=${secrets_directory}"
  printf '%s\n' "FNS_RELAY_ARCHIVE_STAGING_DIR=${archive_staging_directory}"
  printf '%s\n' "FNS_RELAY_VERIFIED_ARCHIVE_DIR=${verified_archive_directory}"
  printf '%s\n' "FNS_RELAY_EVIDENCE_DIR=${smoke_evidence_directory}"
  printf '%s\n' "FNS_RELAY_DRILL_ROOT=${drill_root}"
  printf '%s\n' "FNS_RELAY_TLS_DIR=${tls_directory}"
  printf '%s\n' "FNS_RELAY_ACME_WEBROOT=${acme_directory}"
} >"$environment_file"
chmod 0600 "$environment_file"

bash "${script_directory}/verify-image.sh"
[[ "$(docker image inspect "$FNS_RELAY_IMAGE" --format '{{.Architecture}}')" == "amd64" ]] \
  || fail "target-host smoke currently requires a linux/amd64 Relay image"
smoke_compose --profile edge up --detach
compose_started=true
[[ "$(docker inspect "$relay_container" --format '{{.Config.User}}')" == "10001:10001" ]] \
  || fail "smoke Relay is not configured to run as UID/GID 10001"
[[ "$(docker inspect "$relay_container" --format '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] \
  || fail "smoke Relay root filesystem is not read-only"
private_network="${compose_project}_relay"
public_network="${compose_project}_public"
relay_networks="$(docker inspect "$relay_container" --format '{{json .NetworkSettings.Networks}}')"
edge_networks="$(docker inspect "$edge_container" --format '{{json .NetworkSettings.Networks}}')"
[[ "$relay_networks" == *"\"${private_network}\":"* && "$relay_networks" != *"\"${public_network}\":"* ]] \
  || fail "smoke Relay must be attached only to the private network"
[[ "$edge_networks" == *"\"${private_network}\":"* && "$edge_networks" == *"\"${public_network}\":"* ]] \
  || fail "smoke edge must bridge the public and private networks"
relay_published_ports="$(docker port "$relay_container" 8080/tcp 2>/dev/null || true)"
[[ -z "$relay_published_ports" ]] || fail "smoke Relay must not publish port 8080 to the host"
wait_for_relay_ready
relay_internal_status /healthz
wait_for_edge_ready
[[ "$(edge_status /healthz "${responses_directory}/edge-health.json")" == "404" ]] || fail "edge must not expose /healthz"
[[ "$(edge_status /readyz "${responses_directory}/edge-ready.json")" == "404" ]] || fail "edge must not expose /readyz"

issued="$(admin_capability issue-capability "$(( $(date +%s) + 600 ))" relay:publication:create)"
token="$(printf '%s\n' "$issued" | sed --quiet 's/.*"token":"\([^"]*\)".*/\1/p')"
token_id="$(printf '%s\n' "$issued" | sed --quiet 's/.*"id":"\([^"]*\)".*/\1/p')"
[[ "$token" =~ ^fnsr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || fail "capability issuance returned no bearer token"
[[ "$token_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail "capability issuance returned no capability ID"
printf 'header = "Authorization: Bearer %s"\n' "$token" >"$curl_configuration"
chmod 0600 "$curl_configuration"

context_id="$(make_object_id context)"
binding_a="$(make_object_id binding-a)"
binding_b="$(make_object_id binding-b)"
alias="host-smoke-${run_id}"
printf '{"objectId":"%s","object":{"payload":{"type":"fns.alias.bind","context":"%s","alias":"%s"}}}\n' \
  "$binding_a" "$context_id" "$alias" >"${responses_directory}/publish-a.json"
printf '{"objectId":"%s","object":{"payload":{"type":"fns.alias.bind","context":"%s","alias":"%s"}}}\n' \
  "$binding_b" "$context_id" "$alias" >"${responses_directory}/publish-b.json"
for request_file in "${responses_directory}/publish-a.json" "${responses_directory}/publish-b.json"; do
  status="$(curl --silent --show-error --insecure --noproxy '*' \
    --resolve "${smoke_domain}:${https_port}:127.0.0.1" \
    --config "$curl_configuration" \
    --header 'Content-Type: application/json' \
    --data-binary "@${request_file}" \
    --output "${request_file}.response" \
    --write-out '%{http_code}' \
    "https://${smoke_domain}:${https_port}/v1/publications")"
  [[ "$status" == "201" ]] || fail "smoke publication returned HTTP ${status}"
done
admin_capability revoke-capability "$token_id" >/dev/null
rm --force -- "$curl_configuration"

page_one="${responses_directory}/page-one.json"
page_two="${responses_directory}/page-two.json"
[[ "$(edge_status "/v1/discovery/alias-bindings?context=${context_id}&alias=${alias}&limit=1" "$page_one")" == "200" ]] \
  || fail "first anonymous discovery page did not return HTTP 200"
grep --quiet '"nextCursor"' "$page_one" || fail "first discovery page did not include a cursor"
cursor="$(sed --quiet 's/.*"nextCursor":"\([^"]*\)".*/\1/p' "$page_one")"
[[ -n "$cursor" ]] || fail "first discovery page had an empty cursor"
[[ "$(edge_status "/v1/discovery/alias-bindings?context=${context_id}&alias=${alias}&limit=1&cursor=${cursor}" "$page_two")" == "200" ]] \
  || fail "second anonymous discovery page did not return HTTP 200"
grep --quiet '"complete":true' "$page_two" || fail "second discovery page was not complete"

smoke_compose stop --timeout 12 relay
[[ "$(docker inspect "$relay_container" --format '{{.State.ExitCode}}')" == "0" ]] \
  || fail "Relay did not exit cleanly after SIGTERM"
smoke_compose up --detach --no-deps relay
wait_for_relay_ready
[[ "$(edge_status "/v1/objects/${binding_a}" "${responses_directory}/restart-object.json")" == "200" ]] \
  || fail "candidate/blob did not survive Relay restart"

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
smoke_manifest="$(find "$verified_archive_directory" -maxdepth 1 -type f -name 'relay-*.manifest.json' -printf '%T@ %p\n' | sort --numeric-sort --reverse | head --lines 1 | cut --delimiter=' ' --fields=2-)"
[[ -n "$smoke_manifest" ]] || fail "smoke archive did not create a verified manifest"
smoke_archive_name="$(archive_name_from_manifest "$smoke_manifest")"
smoke_archive="${verified_archive_directory}/${smoke_archive_name}"
require_existing_file "$smoke_archive"

restored_root="${run_root}/restored"
restored_candidates="${restored_root}/candidates"
restored_blobs="${restored_root}/blobs"
restored_capabilities="${restored_root}/capabilities"
restored_secrets="${restored_root}/secrets"
restored_archive="${restored_root}/archive"
for directory in "$restored_candidates" "$restored_blobs" "$restored_capabilities"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0700 "$directory"
done
install --directory --owner root --group "$SMOKE_RUNTIME_GID" --mode 0710 "$restored_secrets"
install --directory --owner root --group "$SMOKE_RUNTIME_GID" --mode 0750 "$restored_archive"
install --mode 0440 --owner root --group "$SMOKE_RUNTIME_GID" "$smoke_archive" "${restored_archive}/${smoke_archive_name}"
make_secret "${restored_secrets}/capability-pepper"
make_secret "${restored_secrets}/cursor-secret"
docker run --rm --network none "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${restored_archive},target=/archive,readonly" \
  --mount "type=bind,source=${restored_candidates},target=/var/lib/fns-relay/candidates" \
  --mount "type=bind,source=${restored_blobs},target=/var/lib/fns-relay/blobs" \
  --entrypoint node "$FNS_RELAY_IMAGE" relay-v1/apps/public-relay/bin/admin.js restore-replace \
  "/archive/${smoke_archive_name}" --confirm-replace >/dev/null
docker run --detach --name "$restore_container" "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --publish 127.0.0.1::8080 \
  --mount "type=bind,source=${restored_candidates},target=/var/lib/fns-relay/candidates" \
  --mount "type=bind,source=${restored_blobs},target=/var/lib/fns-relay/blobs" \
  --mount "type=bind,source=${restored_capabilities},target=/var/lib/fns-relay/capabilities" \
  --mount "type=bind,source=${restored_secrets},target=/run/secrets,readonly" \
  --env FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper \
  --env FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret \
  "$FNS_RELAY_IMAGE" >/dev/null
restored_port="$(docker port "$restore_container" 8080/tcp | sed --quiet 's/.*:\([0-9][0-9]*\)$/\1/p')"
[[ "$restored_port" =~ ^[0-9]+$ ]] || fail "could not determine restored Relay port"
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --noproxy 127.0.0.1 --output /dev/null "http://127.0.0.1:${restored_port}/readyz"; then break; fi
  sleep 1
done
curl --fail --silent --show-error --noproxy 127.0.0.1 --output /dev/null \
  "http://127.0.0.1:${restored_port}/v1/objects/${binding_a}"

bad_candidates="${run_root}/bad-permissions/candidates"
bad_blobs="${run_root}/bad-permissions/blobs"
bad_capabilities="${run_root}/bad-permissions/capabilities"
bad_secrets="${run_root}/bad-permissions/secrets"
install --directory --owner root --group root --mode 0700 "$bad_candidates"
for directory in "$bad_blobs" "$bad_capabilities"; do
  install --directory --owner "$SMOKE_RUNTIME_UID" --group "$SMOKE_RUNTIME_GID" --mode 0700 "$directory"
done
install --directory --owner root --group "$SMOKE_RUNTIME_GID" --mode 0710 "$bad_secrets"
make_secret "${bad_secrets}/capability-pepper"
make_secret "${bad_secrets}/cursor-secret"
set +e
timeout 30s docker run --name "$failure_container" "${FNS_RELAY_HARDENED_ARGS[@]}" \
  --mount "type=bind,source=${bad_candidates},target=/var/lib/fns-relay/candidates" \
  --mount "type=bind,source=${bad_blobs},target=/var/lib/fns-relay/blobs" \
  --mount "type=bind,source=${bad_capabilities},target=/var/lib/fns-relay/capabilities" \
  --mount "type=bind,source=${bad_secrets},target=/run/secrets,readonly" \
  --env FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper \
  --env FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret \
  "$FNS_RELAY_IMAGE" >"${responses_directory}/bad-permissions.stdout" 2>"${responses_directory}/bad-permissions.stderr"
bad_exit=$?
set -e
[[ "$bad_exit" -ne 0 && "$bad_exit" -ne 124 ]] || fail "bad ownership did not produce a clear startup failure"
grep --quiet 'FNS_RELAY_CANDIDATES_DB' "${responses_directory}/bad-permissions.stderr" \
  || fail "bad ownership failure did not identify the candidate database path"

result_status="success"
printf 'target-host smoke completed; evidence: %s\n' "$result_file"
