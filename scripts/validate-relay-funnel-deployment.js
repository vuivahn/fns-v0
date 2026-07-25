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

const composePath = "ops/host-relay/compose.funnel.yaml";
const compose = read(composePath);
const relayService = compose.match(/^ {2}relay:\n([\s\S]*?)^\n {2}funnel-edge:/m)?.[1] ?? "";
const edgeService = compose.match(/^ {2}funnel-edge:\n([\s\S]*?)^\nnetworks:/m)?.[1] ?? "";
const composeNetworks = compose.match(/^networks:\n([\s\S]*)$/m)?.[1] ?? "";
if (compose.includes("build:")) failures.push(`${composePath} must not build a mutable runtime image`);
if (relayService === "" || edgeService === "" || composeNetworks === "")
  failures.push(`${composePath} must define Relay, Funnel edge, and networks blocks`);
if (relayService.includes("ports:")) failures.push(`${composePath} must keep Relay off host ports`);
if (relayService.includes("- public") || edgeService.includes("- public"))
  failures.push(`${composePath} must not create a public Docker network`);
if (!edgeService.includes('"${FNS_RELAY_FUNNEL_EDGE_BIND:-127.0.0.1}:${FNS_RELAY_FUNNEL_EDGE_PORT:-18080}:8080"'))
  failures.push(`${composePath} must publish only the configurable loopback Funnel edge port`);
for (const forbidden of [
  "FNS_RELAY_EDGE_HTTP",
  "FNS_RELAY_EDGE_HTTPS",
  "FNS_RELAY_TLS_DIR",
  "FNS_RELAY_ACME_WEBROOT",
  "NET_BIND_SERVICE"
]) {
  if (compose.includes(forbidden)) failures.push(`${composePath} must not retain direct-TLS setting ${forbidden}`);
}
for (const expected of [
  'user: "10001:10001"',
  'user: "101:101"',
  "read_only: true",
  "create_host_path: false",
  "no-new-privileges:true",
  "relay:\n    internal: true"
])
  requireText(composePath, compose, expected);
for (const expected of [
  "/etc/nginx/conf.d:rw,nosuid,nodev,noexec,size=1m,mode=0750,uid=101,gid=101",
  "/var/cache/nginx:rw,nosuid,nodev,noexec,size=16m,mode=0750,uid=101,gid=101",
  "/run:rw,nosuid,nodev,noexec,size=1m,mode=0750,uid=101,gid=101"
])
  requireText(composePath, edgeService, expected);

const edgePath = "ops/host-relay/nginx/funnel.conf.template";
const edge = read(edgePath);
for (const expected of [
  "listen 8080 proxy_protocol;",
  "limit_req_zone $proxy_protocol_addr",
  "limit_conn_zone $proxy_protocol_addr",
  "location = /healthz",
  "location = /readyz",
  "proxy_set_header X-Forwarded-Proto https;",
  "proxy_set_header X-Forwarded-For $proxy_protocol_addr;",
  "proxy_set_header Authorization $http_authorization;",
  "client_max_body_size 256k"
])
  requireText(edgePath, edge, expected);
for (const forbidden of ["$binary_remote_addr", "$proxy_add_x_forwarded_for", "ssl_certificate"]) {
  if (edge.includes(forbidden)) failures.push(`${edgePath} must not contain ${JSON.stringify(forbidden)}`);
}
if (/\blisten 80(?:[;\s])/.test(edge) || /\blisten 443(?:[;\s])/.test(edge))
  failures.push(`${edgePath} must not listen on direct-TLS ports`);
const logFormat = edge.split(/\r?\n/).find((line) => line.startsWith("log_format fns_relay")) ?? "";
if (logFormat.includes("$request_uri") || logFormat.includes("$http_authorization"))
  failures.push(`${edgePath} access log format must redact URI and authorization`);

const environmentPath = "ops/host-relay/relay.funnel.env.example";
const environment = read(environmentPath);
for (const expected of [
  "FNS_RELAY_FUNNEL_EDGE_BIND=127.0.0.1",
  "FNS_RELAY_FUNNEL_EDGE_PORT=18080",
  "FNS_RELAY_FUNNEL_PUBLIC_PORT=8443",
  "FNS_RELAY_NODE_IMAGE=node@sha256:",
  "FNS_RELAY_EDGE_IMAGE=nginx@sha256:"
])
  requireText(environmentPath, environment, expected);
if (/^FNS_RELAY_(CAPABILITY_PEPPER|CURSOR_SECRET)=/m.test(environment))
  failures.push(`${environmentPath} must not contain Relay secret values`);

const funnelPath = "ops/host-relay/bin/funnel.sh";
const funnel = read(funnelPath);
for (const expected of [
  "FNS_RELAY_FUNNEL_EDGE_BIND must be exactly 127.0.0.1",
  "--bg --yes --proxy-protocol=2",
  "--tls-terminated-tcp=",
  "tcp://127.0.0.1:",
  "tailscale funnel status --json",
  "FNS_RELAY_FUNNEL_PUBLIC_PORT must be one of 443, 8443, or 10000"
])
  requireText(funnelPath, funnel, expected);
if (funnel.includes("funnel reset")) failures.push(`${funnelPath} must not reset unrelated Funnel configuration`);

const clientPath = "ops/host-relay/bin/funnel-proxy-client.js";
const client = read(clientPath);
for (const expected of [
  "proxyHeader[12] = 0x21",
  "proxyHeader[13] = 0x11",
  "Connection: close",
  "upstream closed without an HTTP response"
])
  requireText(clientPath, client, expected);

const smokePath = "ops/host-relay/bin/target-host-funnel-smoke.sh";
const smoke = read(smokePath);
for (const expected of [
  "I_UNDERSTAND_THIS_IS_NONPRODUCTION",
  "compose.funnel.yaml",
  "funnel-proxy-client.js",
  "--network host",
  "proxyProtocol",
  "relay:publication:create",
  "nextCursor",
  "archive.sh"
])
  requireText(smokePath, smoke, expected);
if (smoke.includes("tailscale funnel"))
  failures.push(`${smokePath} must test the backend boundary without changing Tailscale state`);

const bootstrapPath = "ops/host-relay/bin/home-funnel-beta-bootstrap.sh";
const bootstrap = read(bootstrapPath);
for (const expected of [
  "I_UNDERSTAND_HOME_FUNNEL_BETA_IS_NOT_SLO_COMPLIANT",
  "FNS_RELAY_HOME_BETA_ROOT",
  "all beta runtime paths must stay below",
  "--network none",
  "--cap-add CHOWN",
  "home-funnel-beta-image-build",
  'recoveryClass":"not-slo-compliant'
])
  requireText(bootstrapPath, bootstrap, expected);
if (bootstrap.includes("docker run --privileged"))
  failures.push(`${bootstrapPath} must not run privileged bootstrap containers`);

const servicePath = "ops/host-relay/systemd/fns-relay-funnel.service";
const service = read(servicePath);
for (const expected of [
  "tailscaled.service",
  "compose.funnel.yaml",
  "funnel.sh start",
  "funnel.sh stop",
  "--project-name fns-relay-funnel"
])
  requireText(servicePath, service, expected);
if (service.includes("--profile edge")) failures.push(`${servicePath} must not start the direct-TLS edge`);

if (failures.length > 0) {
  process.stderr.write(
    `Relay Funnel deployment validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Relay Funnel deployment files validated\n");
}
