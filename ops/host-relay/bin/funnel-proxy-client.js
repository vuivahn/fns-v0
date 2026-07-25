"use strict";

// SPDX-License-Identifier: AGPL-3.0-or-later

// Sends one HTTP/1.1 request behind a syntactically valid PROXY protocol v2
// header. It is run inside the already-reviewed Relay image with host
// networking, so a target-host smoke does not require Node.js on the host.
const fs = require("fs");
const net = require("net");

function fail(message) {
  process.stderr.write(`funnel proxy client: ${message}\n`);
  process.exit(2);
}

const options = {
  host: "127.0.0.1",
  method: "GET",
  path: "/",
  port: undefined,
  hostHeader: "fns-relay.invalid",
  bodyFile: undefined,
  authorizationFile: undefined
};

const names = new Map([
  ["--host", "host"],
  ["--method", "method"],
  ["--path", "path"],
  ["--port", "port"],
  ["--host-header", "hostHeader"],
  ["--body-file", "bodyFile"],
  ["--authorization-file", "authorizationFile"]
]);
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index += 2) {
  const flag = argumentsList[index];
  const property = names.get(flag);
  const value = argumentsList[index + 1];
  if (property === undefined || value === undefined) fail(`invalid argument: ${flag ?? ""}`);
  options[property] = value;
}

const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be a TCP port number");
if (!/^[A-Z]+$/.test(options.method)) fail("--method must be an uppercase HTTP method");
if (!options.path.startsWith("/") || /[\r\n]/.test(options.path)) fail("--path must be a safe absolute path");
if (/[\r\n]/.test(options.host) || /[\r\n]/.test(options.hostHeader)) fail("host values must not contain line breaks");

const body = options.bodyFile === undefined ? Buffer.alloc(0) : fs.readFileSync(options.bodyFile);
const authorization =
  options.authorizationFile === undefined ? "" : fs.readFileSync(options.authorizationFile, "utf8").trim();
if (/[\r\n]/.test(authorization)) fail("authorization file must contain one line");

const proxyHeader = Buffer.alloc(28);
Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]).copy(proxyHeader, 0);
proxyHeader[12] = 0x21; // version 2, PROXY command
proxyHeader[13] = 0x11; // TCP over IPv4
proxyHeader.writeUInt16BE(12, 14);
Buffer.from([198, 51, 100, 10]).copy(proxyHeader, 16); // TEST-NET-2 source address
Buffer.from([127, 0, 0, 1]).copy(proxyHeader, 20);
proxyHeader.writeUInt16BE(43123, 24);
proxyHeader.writeUInt16BE(port, 26);

const headers = [
  `${options.method} ${options.path} HTTP/1.1`,
  `Host: ${options.hostHeader}`,
  "Connection: close",
  "Accept: application/json",
  `Content-Length: ${body.length}`
];
if (authorization !== "") headers.push(`Authorization: Bearer ${authorization}`);
if (body.length > 0) headers.push("Content-Type: application/json");
const request = Buffer.concat([proxyHeader, Buffer.from(`${headers.join("\r\n")}\r\n\r\n`), body]);

const response = [];
let finished = false;
const socket = net.createConnection({ host: options.host, port }, () => socket.end(request));
socket.setTimeout(5000, () => socket.destroy(new Error("request timed out")));
socket.on("data", (chunk) => response.push(chunk));
socket.on("error", (error) => {
  if (!finished) fail(error.message);
});
socket.on("close", () => {
  if (finished) return;
  finished = true;
  const output = Buffer.concat(response);
  if (output.length === 0) fail("upstream closed without an HTTP response");
  process.stdout.write(output);
});
