"use strict";

// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require("fs");
const path = require("path");

const repository = path.resolve(__dirname, "..");
const failures = [];

function read(relativePath) {
  const filename = path.join(repository, relativePath);
  if (!fs.existsSync(filename)) {
    failures.push(`${relativePath} is missing`);
    return "";
  }
  return fs.readFileSync(filename, "utf8");
}

function requireText(relativePath, text, expected) {
  if (!text.includes(expected)) failures.push(`${relativePath} must contain ${JSON.stringify(expected)}`);
}

const compose = read("ops/host-relay/compose.yaml");
const relayService = compose.match(/^ {2}relay:\n([\s\S]*?)^\n {2}edge:/m)?.[1] ?? "";
const edgeService = compose.match(/^ {2}edge:\n([\s\S]*?)^\nnetworks:/m)?.[1] ?? "";
const composeNetworks = compose.match(/^networks:\n([\s\S]*)$/m)?.[1] ?? "";
for (const expected of [
  'user: "10001:10001"',
  'user: "101:101"',
  "read_only: true",
  "FNS_RELAY_RELAY_CONTAINER_NAME:-fns-relay",
  "FNS_RELAY_EDGE_CONTAINER_NAME:-fns-relay-edge",
  "FNS_RELAY_EDGE_HTTPS_PORT:-443",
  "create_host_path: false",
  "no-new-privileges:true"
])
  requireText("ops/host-relay/compose.yaml", compose, expected);
if (compose.includes("build:")) failures.push("ops/host-relay/compose.yaml must not build a mutable runtime image");
if (relayService === "" || edgeService === "" || composeNetworks === "")
  failures.push("ops/host-relay/compose.yaml must define Relay, edge, and networks blocks");
if (relayService.includes("ports:") || relayService.includes("- public"))
  failures.push("ops/host-relay/compose.yaml must keep Relay off host ports and the public network");
if (!edgeService.includes("- public") || !edgeService.includes("- relay"))
  failures.push("ops/host-relay/compose.yaml must attach edge to both public and private networks");
for (const expected of [
  "/etc/nginx/conf.d:rw,nosuid,nodev,noexec,size=1m,mode=0750,uid=101,gid=101",
  "/var/cache/nginx:rw,nosuid,nodev,noexec,size=16m,mode=0750,uid=101,gid=101",
  "/run:rw,nosuid,nodev,noexec,size=1m,mode=0750,uid=101,gid=101"
])
  requireText("ops/host-relay/compose.yaml", edgeService, expected);
if (edgeService.includes("/var/run:"))
  failures.push("ops/host-relay/compose.yaml must mount /run, not the /var/run symlink");
if (!composeNetworks.includes("relay:\n    internal: true") || !composeNetworks.includes("public: {}"))
  failures.push("ops/host-relay/compose.yaml must define an internal Relay network and a public edge network");
if (compose.includes("FNS_RELAY_PROBE_PORT"))
  failures.push("ops/host-relay/compose.yaml must not configure a host Relay probe port");

const edge = read("ops/host-relay/nginx/relay.conf.template");
for (const expected of [
  "limit_req_zone $binary_remote_addr",
  "limit_conn_zone $binary_remote_addr",
  "location = /healthz",
  "location = /readyz",
  "proxy_set_header Authorization $http_authorization",
  "client_max_body_size 256k"
])
  requireText("ops/host-relay/nginx/relay.conf.template", edge, expected);
const logFormat = edge.split(/\r?\n/).find((line) => line.startsWith("log_format fns_relay")) ?? "";
if (logFormat.includes("$request_uri") || logFormat.includes("$http_authorization"))
  failures.push("edge access log format must not contain request URIs or authorization headers");
if ((edge.match(/access_log \/dev\/stdout fns_relay;/g) ?? []).length !== 2)
  failures.push("both edge servers must use the redacted access log format");

const archive = read("ops/host-relay/bin/archive.sh");
for (const expected of [
  "--network none",
  "verify-archive",
  "admin.js export",
  "admin.js verify",
  'bash "${script_directory}/verify-image.sh"'
])
  requireText("ops/host-relay/bin/archive.sh", archive, expected);
if (archive.includes("CAPABILITY_DIR") || archive.includes("SECRETS_DIR"))
  failures.push("archive job must not mount capability storage or Relay secrets");

const archiveService = read("ops/host-relay/systemd/fns-relay-archive.service");
requireText("ops/host-relay/systemd/fns-relay-archive.service", archiveService, "TimeoutStartSec=10min");
const archiveTimer = read("ops/host-relay/systemd/fns-relay-archive.timer");
for (const expected of ["OnBootSec=2min", "OnUnitInactiveSec=15min"])
  requireText("ops/host-relay/systemd/fns-relay-archive.timer", archiveTimer, expected);

const offProvider = read("ops/host-relay/bin/off-provider-copy.sh");
for (const expected of ["rclone copyto --immutable", "rclone cat", "receipts/", "off-provider-copy"])
  requireText("ops/host-relay/bin/off-provider-copy.sh", offProvider, expected);

const drill = read("ops/host-relay/bin/restore-drill.sh");
for (const expected of [
  "latest_off_provider_receipt",
  "FNS_RELAY_RESTORE_ARCHIVE_NAME",
  "verify-archive",
  "restore-replace",
  "/readyz",
  "/v1/objects/",
  "docker build",
  "node_image_from_manifest",
  "recovered Relay image source offer"
])
  requireText("ops/host-relay/bin/restore-drill.sh", drill, expected);
if (drill.includes("FNS_RELAY_CANDIDATE_DIR},target"))
  failures.push("restore drill must not mount production candidate storage");

const sloCheck = read("ops/host-relay/bin/check-slos.sh");
for (const expected of [
  "restore_status",
  "latest restore drill did not succeed",
  "docker inspect",
  "docker exec",
  "/readyz"
])
  requireText("ops/host-relay/bin/check-slos.sh", sloCheck, expected);
if (sloCheck.includes("FNS_RELAY_PROBE_PORT") || sloCheck.includes("127.0.0.1:"))
  failures.push("ops/host-relay/bin/check-slos.sh must not bypass the edge with a host Relay probe port");

const environment = read("ops/host-relay/relay.env.example");
for (const expected of ["FNS_RELAY_NODE_IMAGE=node@sha256:", "FNS_RELAY_EDGE_IMAGE=nginx@sha256:"])
  requireText("ops/host-relay/relay.env.example", environment, expected);
if (/^FNS_RELAY_(CAPABILITY_PEPPER|CURSOR_SECRET)=/m.test(environment))
  failures.push("relay.env.example must not contain Relay secret values");
if (environment.includes("FNS_RELAY_PROBE_PORT"))
  failures.push("relay.env.example must not configure a host Relay probe port");

for (const relativePath of [
  "ops/host-relay/systemd/fns-relay.service",
  "ops/host-relay/systemd/fns-relay-archive.service",
  "ops/host-relay/systemd/fns-relay-archive.timer",
  "ops/host-relay/systemd/fns-relay-off-provider.service",
  "ops/host-relay/systemd/fns-relay-off-provider.timer",
  "ops/host-relay/systemd/fns-relay-restore-drill.service",
  "ops/host-relay/systemd/fns-relay-restore-drill.timer",
  "ops/host-relay/systemd/fns-relay-slo-check.service",
  "ops/host-relay/systemd/fns-relay-slo-check.timer"
])
  read(relativePath);

const imageVerification = read("ops/host-relay/bin/verify-image.sh");
for (const expected of ["current-image-build.json", "FNS_RELAY_EDGE_IMAGE", "Relay image ID differs"])
  requireText("ops/host-relay/bin/verify-image.sh", imageVerification, expected);

const hostSmoke = read("ops/host-relay/bin/target-host-smoke.sh");
for (const expected of [
  "I_UNDERSTAND_THIS_IS_NONPRODUCTION",
  "FNS_RELAY_SMOKE_ROOT",
  "--resolve",
  "relay:publication:create",
  "nextCursor",
  "smoke_compose stop",
  "relay_internal_status",
  "wait_for_relay_ready",
  "wait_for_edge_ready",
  "archive.sh",
  "restore-replace",
  "bad-permissions",
  'bash "${script_directory}/verify-image.sh"',
  'bash "${script_directory}/archive.sh"'
])
  requireText("ops/host-relay/bin/target-host-smoke.sh", hostSmoke, expected);
if (hostSmoke.includes("FNS_RELAY_SMOKE_PROBE_PORT") || hostSmoke.includes("FNS_RELAY_PROBE_PORT"))
  failures.push("target-host smoke must keep the Relay probe inside the private network");

for (const [relativePath, script] of [
  ["ops/host-relay/bin/restore-drill.sh", drill],
  ["ops/host-relay/bin/target-host-smoke.sh", hostSmoke]
]) {
  if (script.includes("od --an")) failures.push(`${relativePath} must use portable od short options`);
  requireText(relativePath, script, "od -An");
}

if (failures.length > 0) {
  process.stderr.write(
    `Relay Linux host deployment validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Relay Linux host deployment files validated\n");
}
