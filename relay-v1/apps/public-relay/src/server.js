"use strict";

const http = require("http");
const { URL } = require("url");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("../../../../src");
const {
  RelayAdmissionError,
  RelayAuthenticationError,
  RelayLimitError,
  RelayProtocolError
} = require("../../../packages/relay-contract/src/errors");
const { CursorCodec, paginateEnvelope, parseLimit } = require("./cursor-codec");

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff"
};

function writeJson(response, status, body, headers = {}, maximumResponseBytes = null) {
  const representation = JSON.stringify(body);
  const length = Buffer.byteLength(representation, "utf8");
  if (maximumResponseBytes !== null && length > maximumResponseBytes)
    throw new RelayLimitError("response exceeds the configured limit", { maximumResponseBytes });
  response.writeHead(status, { ...JSON_HEADERS, "content-length": length, ...headers });
  response.end(representation);
}

async function readJsonBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new RelayLimitError("request body exceeds the configured limit", { maximumBytes });
    chunks.push(chunk);
  }
  if (size === 0) throw new RelayProtocolError("request body is required");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new RelayProtocolError("request body must be a JSON object");
    return value;
  } catch (error) {
    if (error instanceof RelayProtocolError) throw error;
    throw new RelayProtocolError("request body is not valid JSON");
  }
}

function errorStatus(error) {
  if (error instanceof RelayAuthenticationError) return 401;
  if (error instanceof RelayAdmissionError) return 403;
  if (error instanceof RelayLimitError) return 413;
  if (error instanceof InvalidRequestError || error instanceof RelayProtocolError) return 400;
  if (error instanceof StoreIntegrityError) return 409;
  if (error instanceof StoreAccessError) return 503;
  return 500;
}

function decodePathParameter(value, name) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RelayProtocolError(`${name} is not valid percent-encoded text`);
  }
}

function publicError(error) {
  const status = errorStatus(error);
  return {
    status,
    body: {
      error: {
        code: error?.code ?? "E_RELAY_INTERNAL",
        message: status === 500 ? "internal Relay error" : error.message
      }
    }
  };
}

function requireRelay(relay) {
  const methods = [
    "getObject",
    "findAliasBindings",
    "findAliasReleases",
    "findCommuneDocuments",
    "findAliasBindingsPage",
    "findAliasReleasesPage",
    "findCommuneDocumentsPage",
    "publish",
    "readiness",
    "verifyIntegrity"
  ];
  if (!relay || methods.some((method) => typeof relay[method] !== "function"))
    throw new RelayProtocolError("relay does not implement the public Relay application port");
  return relay;
}

function isKnownV1Route(pathname) {
  return (
    pathname.startsWith("/v1/objects/") ||
    [
      "/v1/discovery/alias-bindings",
      "/v1/discovery/alias-releases",
      "/v1/discovery/commune-documents",
      "/v1/publications"
    ].includes(pathname)
  );
}

function normalizeSourceOfferUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new RelayProtocolError("sourceOfferUrl must be an immutable HTTPS source archive URL or null");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RelayProtocolError("sourceOfferUrl must be an immutable HTTPS source archive URL or null");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0 ||
    !/\/archive\/[0-9a-f]{40}\.tar\.gz$/.test(parsed.pathname)
  )
    throw new RelayProtocolError(
      "sourceOfferUrl must be an immutable HTTPS source archive URL without credentials, query, or fragment"
    );
  return parsed.toString();
}

function createPublicRelayServer({
  relay,
  cursorSecret,
  now = () => Date.now(),
  defaultPageSize = 100,
  maximumPageSize = 1000,
  maximumRequestBytes = 262144,
  maximumResponseBytes = 1048576,
  maximumUrlBytes = 8192,
  sourceOfferUrl = null
}) {
  requireRelay(relay);
  if (!Number.isSafeInteger(defaultPageSize) || defaultPageSize < 1 || defaultPageSize > maximumPageSize)
    throw new RelayProtocolError("defaultPageSize is invalid", { defaultPageSize, maximumPageSize });
  if (!Number.isSafeInteger(maximumPageSize) || maximumPageSize < 1 || maximumPageSize > 10000)
    throw new RelayProtocolError("maximumPageSize is invalid", { maximumPageSize });
  if (!Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes < 1)
    throw new RelayProtocolError("maximumRequestBytes is invalid", { maximumRequestBytes });
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1)
    throw new RelayProtocolError("maximumResponseBytes is invalid", { maximumResponseBytes });
  if (!Number.isSafeInteger(maximumUrlBytes) || maximumUrlBytes < 1)
    throw new RelayProtocolError("maximumUrlBytes is invalid", { maximumUrlBytes });
  const cursorCodec = new CursorCodec({ secret: cursorSecret, now });
  const normalizedSourceOfferUrl = normalizeSourceOfferUrl(sourceOfferUrl);
  const sourceOfferHeaders =
    normalizedSourceOfferUrl === null ? {} : { link: `<${normalizedSourceOfferUrl}>; rel="source"` };

  return http.createServer(async (request, response) => {
    // A client that aborts mid-write emits an "error" event on the request or
    // response. With no listener Node treats it as an uncaught exception and
    // exits the process, so a single flaky peer can take the Relay down.
    request.on("error", () => {});
    response.on("error", () => {});
    try {
      if (typeof request.url !== "string" || Buffer.byteLength(request.url, "utf8") > maximumUrlBytes)
        throw new RelayLimitError("request URL exceeds the configured limit", { maximumUrlBytes });
      const url = new URL(request.url, "http://relay.invalid");
      const send = (status, body, headers = {}) =>
        writeJson(response, status, body, { ...sourceOfferHeaders, ...headers }, maximumResponseBytes);
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(200, { status: "ok", relay: "fns.relay.v1" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/.well-known/fns-source") {
        if (normalizedSourceOfferUrl === null) {
          send(404, { error: { code: "E_RELAY_NOT_FOUND", message: "source offer was not configured" } });
          return;
        }
        send(200, {
          license: "AGPL-3.0-or-later",
          correspondingSource: normalizedSourceOfferUrl
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const readiness = await relay.readiness();
        send(200, { status: "ready", readiness });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/objects/")) {
        const objectId = decodePathParameter(url.pathname.slice("/v1/objects/".length), "objectId");
        const candidate = await relay.getObject(objectId);
        if (!candidate) {
          send(404, { error: { code: "E_RELAY_NOT_FOUND", message: "object was not found" } });
          return;
        }
        send(200, candidate);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/discovery/alias-bindings") {
        const query = { context: url.searchParams.get("context"), alias: url.searchParams.get("alias") };
        const limit = parseLimit(url.searchParams.get("limit"), defaultPageSize, maximumPageSize);
        const cursor = url.searchParams.get("cursor");
        const afterObjectId =
          cursor === null ? null : cursorCodec.parse(cursor, { route: url.pathname, query }).lastObjectId;
        const envelope = await relay.findAliasBindingsPage(query.context, query.alias, { afterObjectId, limit });
        const page = paginateEnvelope(envelope, {
          route: url.pathname,
          query,
          limit,
          cursorCodec
        });
        send(200, page);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/discovery/alias-releases") {
        const query = { bindingIds: url.searchParams.getAll("binding").sort() };
        const limit = parseLimit(url.searchParams.get("limit"), defaultPageSize, maximumPageSize);
        const cursor = url.searchParams.get("cursor");
        const afterObjectId =
          cursor === null ? null : cursorCodec.parse(cursor, { route: url.pathname, query }).lastObjectId;
        const envelope = await relay.findAliasReleasesPage(query.bindingIds, { afterObjectId, limit });
        const page = paginateEnvelope(envelope, {
          route: url.pathname,
          query,
          limit,
          cursorCodec
        });
        send(200, page);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/discovery/commune-documents") {
        const query = { context: url.searchParams.get("context") };
        const limit = parseLimit(url.searchParams.get("limit"), defaultPageSize, maximumPageSize);
        const cursor = url.searchParams.get("cursor");
        const afterObjectId =
          cursor === null ? null : cursorCodec.parse(cursor, { route: url.pathname, query }).lastObjectId;
        const envelope = await relay.findCommuneDocumentsPage(query.context, { afterObjectId, limit });
        const page = paginateEnvelope(envelope, {
          route: url.pathname,
          query,
          limit,
          cursorCodec
        });
        send(200, page);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/publications") {
        const candidate = await readJsonBody(request, maximumRequestBytes);
        const result = await relay.publish(candidate, {
          authorization: request.headers.authorization,
          request: { remoteAddress: request.socket.remoteAddress ?? null }
        });
        send(result.publication.inserted === 0 ? 200 : 201, result.candidate);
        return;
      }
      if (isKnownV1Route(url.pathname)) {
        send(405, { error: { code: "E_RELAY_METHOD", message: "method is not allowed" } }, { allow: "GET, POST" });
        return;
      }
      send(404, { error: { code: "E_RELAY_NOT_FOUND", message: "route was not found" } });
    } catch (error) {
      if (response.headersSent) {
        // Headers (and possibly part of the body) already went out before the
        // failure; the response cannot be replaced, so just end the socket.
        if (!response.writableEnded) response.end();
        return;
      }
      const publicResult = publicError(error);
      // A limit response must still be deliverable even when the configured
      // representation budget is smaller than the structured error itself.
      writeJson(response, publicResult.status, publicResult.body, sourceOfferHeaders);
    }
  });
}

module.exports = { createPublicRelayServer, normalizeSourceOfferUrl };
