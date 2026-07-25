"use strict";

const crypto = require("crypto");
const { stableJson } = require("../../../../src/store-utils");
const { RelayProtocolError } = require("../../../packages/relay-contract/src/errors");

const CURSOR_PREFIX = "fnsrc1";

function normalizeSecret(secret) {
  const value = Buffer.isBuffer(secret) ? Buffer.from(secret) : typeof secret === "string" ? Buffer.from(secret) : null;
  if (!value || value.length < 32)
    throw new RelayProtocolError("cursor secret must contain at least 32 bytes of secret material");
  return value;
}

function parseLimit(value, defaultLimit, maximum) {
  if (value === null || value === "") return defaultLimit;
  if (!/^[1-9][0-9]*$/.test(value)) throw new RelayProtocolError("limit must be a positive integer", { limit: value });
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > maximum)
    throw new RelayProtocolError("limit exceeds the configured maximum", { limit, maximum });
  return limit;
}

class CursorCodec {
  constructor({ secret, now = () => Date.now(), ttlSeconds = 300 }) {
    if (typeof now !== "function") throw new RelayProtocolError("cursor clock must be a function");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)
      throw new RelayProtocolError("cursor ttlSeconds must be between 1 and 3600", { ttlSeconds });
    this.secret = normalizeSecret(secret);
    this.now = now;
    this.ttlSeconds = ttlSeconds;
  }

  #sign(encodedPayload) {
    return crypto.createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");
  }

  create({ route, query, lastObjectId }) {
    if (typeof route !== "string" || route.length === 0 || typeof lastObjectId !== "string")
      throw new RelayProtocolError("cursor route and lastObjectId are required");
    const expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
    const payload = { version: 1, route, query, lastObjectId, expiresAt };
    let encodedPayload;
    try {
      encodedPayload = Buffer.from(stableJson(payload)).toString("base64url");
    } catch {
      throw new RelayProtocolError("cursor query must be a JSON value");
    }
    return `${CURSOR_PREFIX}.${encodedPayload}.${this.#sign(encodedPayload)}`;
  }

  parse(value, { route, query }) {
    if (typeof value !== "string") throw new RelayProtocolError("cursor must be a string");
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw new RelayProtocolError("cursor is malformed");
    const suppliedSignature = Buffer.from(parts[2], "base64url");
    const expectedSignature = Buffer.from(this.#sign(parts[1]), "base64url");
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    )
      throw new RelayProtocolError("cursor signature is invalid");
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new RelayProtocolError("cursor payload is malformed");
    }
    let queryMatches = false;
    try {
      queryMatches = stableJson(payload?.query) === stableJson(query);
    } catch {
      throw new RelayProtocolError("cursor is not valid for this request");
    }
    if (
      !payload ||
      payload.version !== 1 ||
      payload.route !== route ||
      !queryMatches ||
      typeof payload.lastObjectId !== "string" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= Math.floor(this.now() / 1000)
    )
      throw new RelayProtocolError("cursor is not valid for this request");
    return payload;
  }
}

function paginateEnvelope(envelope, { route, query, limit, cursorCodec }) {
  if (!envelope || typeof envelope.hasMore !== "boolean")
    throw new RelayProtocolError("paged Relay envelope must declare hasMore");
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RelayProtocolError("paged Relay envelope limit is invalid", { limit });
  const { hasMore, ...publicEnvelope } = envelope;
  const last = publicEnvelope.objects[publicEnvelope.objects.length - 1];
  if (hasMore && !last) throw new RelayProtocolError("paged Relay envelope is missing a cursor object");
  return {
    ...publicEnvelope,
    page: {
      complete: !hasMore,
      nextCursor: !hasMore ? null : cursorCodec.create({ route, query, lastObjectId: last.objectId })
    }
  };
}

module.exports = { CursorCodec, paginateEnvelope, parseLimit };
