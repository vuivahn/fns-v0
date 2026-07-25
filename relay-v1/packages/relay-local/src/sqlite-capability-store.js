"use strict";

const crypto = require("crypto");
const Database = require("better-sqlite3");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("../../../../src");
const { cloneJson, compareText, stableJson } = require("../../../../src/store-utils");
const { RelayAuthenticationError, RelayProtocolError } = require("../../relay-contract/src/errors");

const CAPABILITY_PREFIX = "fnsr1";
const TOKEN_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_SECRET = /^[A-Za-z0-9_-]{43}$/;
const SCOPE = /^[A-Za-z][A-Za-z0-9._:-]{0,191}$/;

function mapDatabaseError(error, message) {
  if (
    error instanceof InvalidRequestError ||
    error instanceof StoreAccessError ||
    error instanceof StoreIntegrityError ||
    error instanceof RelayAuthenticationError ||
    error instanceof RelayProtocolError
  )
    return error;
  return new StoreAccessError(message, { reason: error instanceof Error ? error.message : String(error) });
}

function normalizePepper(pepper) {
  const value = Buffer.isBuffer(pepper) ? Buffer.from(pepper) : typeof pepper === "string" ? Buffer.from(pepper) : null;
  if (!value || value.length < 32)
    throw new InvalidRequestError("capability pepper must contain at least 32 bytes of secret material");
  return value;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32)
    throw new RelayProtocolError("scopes must contain between one and 32 values");
  const normalized = [...new Set(scopes)];
  if (normalized.some((scope) => typeof scope !== "string" || !SCOPE.test(scope)))
    throw new RelayProtocolError("scope is not valid", { scopes });
  return normalized.sort(compareText);
}

function normalizeExpiry(expiresAt, nowSeconds) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds)
    throw new RelayProtocolError("expiresAt must be a future Unix timestamp in seconds", { expiresAt });
  return expiresAt;
}

function parseAuthorization(authorization) {
  if (typeof authorization !== "string") throw new RelayAuthenticationError("missing bearer capability");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new RelayAuthenticationError("missing bearer capability");
  const parts = match[1].split(".");
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX || !TOKEN_ID.test(parts[1]) || !TOKEN_SECRET.test(parts[2]))
    throw new RelayAuthenticationError("invalid bearer capability");
  return { tokenId: parts[1], tokenSecret: parts[2] };
}

class SQLiteCapabilityStore {
  constructor({ filename, pepper, now = () => Date.now() }) {
    if (typeof filename !== "string" || filename.length === 0)
      throw new InvalidRequestError("filename must be a non-empty string", { filename });
    if (typeof now !== "function") throw new InvalidRequestError("now must be a function");
    this.pepper = normalizePepper(pepper);
    this.now = now;
    try {
      this.db = new Database(filename, { timeout: 5000 });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS relay_capabilities (
          token_id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          subject TEXT,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS relay_capabilities_expiry_index ON relay_capabilities (expires_at);
      `);
    } catch (error) {
      throw mapDatabaseError(error, "unable to initialize capability store");
    }
  }

  #nowSeconds() {
    const milliseconds = this.now();
    if (!Number.isFinite(milliseconds)) throw new StoreAccessError("capability clock returned an invalid value");
    return Math.floor(milliseconds / 1000);
  }

  #hash(tokenId, tokenSecret) {
    return crypto.createHmac("sha256", this.pepper).update(`${tokenId}.${tokenSecret}`).digest("base64url");
  }

  #read(tokenId) {
    const row = this.db
      .prepare(
        "SELECT token_id, token_hash, scopes_json, subject, issued_at, expires_at, revoked_at FROM relay_capabilities WHERE token_id = ?"
      )
      .get(tokenId);
    if (!row) return null;
    let scopes;
    try {
      scopes = JSON.parse(row.scopes_json);
      scopes = normalizeScopes(scopes);
    } catch {
      throw new StoreIntegrityError("capability store has invalid scope data", { tokenId });
    }
    if (
      !TOKEN_ID.test(row.token_id) ||
      !TOKEN_SECRET.test(row.token_hash) ||
      (row.subject !== null && typeof row.subject !== "string") ||
      !Number.isSafeInteger(row.issued_at) ||
      !Number.isSafeInteger(row.expires_at) ||
      (row.revoked_at !== null && !Number.isSafeInteger(row.revoked_at))
    )
      throw new StoreIntegrityError("capability store has invalid token metadata", { tokenId });
    return {
      id: row.token_id,
      tokenHash: row.token_hash,
      scopes,
      subject: row.subject,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    };
  }

  create({ scopes, expiresAt, subject = null }) {
    const nowSeconds = this.#nowSeconds();
    const normalizedScopes = normalizeScopes(scopes);
    const normalizedExpiry = normalizeExpiry(expiresAt, nowSeconds);
    if (subject !== null && (typeof subject !== "string" || subject.length === 0 || subject.length > 256))
      throw new RelayProtocolError("subject must be a non-empty string up to 256 characters or null", { subject });
    const tokenId = crypto.randomBytes(16).toString("base64url");
    const tokenSecret = crypto.randomBytes(32).toString("base64url");
    try {
      this.db
        .prepare(
          `INSERT INTO relay_capabilities
            (token_id, token_hash, scopes_json, subject, issued_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          tokenId,
          this.#hash(tokenId, tokenSecret),
          stableJson(normalizedScopes),
          subject,
          nowSeconds,
          normalizedExpiry
        );
    } catch (error) {
      throw mapDatabaseError(error, "unable to create capability");
    }
    return {
      token: `${CAPABILITY_PREFIX}.${tokenId}.${tokenSecret}`,
      capability: {
        id: tokenId,
        scopes: cloneJson(normalizedScopes),
        subject,
        issuedAt: nowSeconds,
        expiresAt: normalizedExpiry
      }
    };
  }

  verifyBearer(authorization, { requiredScopes = null } = {}) {
    const { tokenId, tokenSecret } = parseAuthorization(authorization);
    if (requiredScopes !== null && !Array.isArray(requiredScopes))
      throw new RelayProtocolError("requiredScopes must be an array or null", { requiredScopes });
    const expectedScopes = requiredScopes === null ? [] : normalizeScopes(requiredScopes);
    try {
      const capability = this.#read(tokenId);
      if (!capability) throw new RelayAuthenticationError("invalid bearer capability");
      const suppliedHash = Buffer.from(this.#hash(tokenId, tokenSecret), "base64url");
      const storedHash = Buffer.from(capability.tokenHash, "base64url");
      if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash))
        throw new RelayAuthenticationError("invalid bearer capability");
      const nowSeconds = this.#nowSeconds();
      if (capability.revokedAt !== null || capability.expiresAt <= nowSeconds)
        throw new RelayAuthenticationError("expired or revoked bearer capability");
      if (!expectedScopes.every((scope) => capability.scopes.includes(scope)))
        throw new RelayAuthenticationError("bearer capability does not have the required scope");
      return {
        id: capability.id,
        scopes: cloneJson(capability.scopes),
        subject: capability.subject,
        issuedAt: capability.issuedAt,
        expiresAt: capability.expiresAt
      };
    } catch (error) {
      throw mapDatabaseError(error, "unable to verify bearer capability");
    }
  }

  revoke(tokenId) {
    if (!TOKEN_ID.test(tokenId)) throw new RelayProtocolError("tokenId is invalid", { tokenId });
    try {
      const result = this.db
        .prepare("UPDATE relay_capabilities SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
        .run(this.#nowSeconds(), tokenId);
      return result.changes === 1;
    } catch (error) {
      throw mapDatabaseError(error, "unable to revoke capability");
    }
  }

  readiness() {
    try {
      this.db.prepare("SELECT 1 AS ready").get();
      return { database: "ok" };
    } catch (error) {
      throw mapDatabaseError(error, "capability store is not ready");
    }
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      throw mapDatabaseError(error, "unable to close capability store");
    }
  }
}

module.exports = { SQLiteCapabilityStore };
