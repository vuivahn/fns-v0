"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("./errors");
const { FnsStore } = require("./fns-store");
const {
  DISCOVERY_VERSION,
  METHOD_NAMES,
  assertJsonValue,
  byDiagnostic,
  byObjectId,
  candidate,
  cloneJson,
  compareText,
  hasOwn,
  isCanonicalObjectId,
  isJsonValue,
  requireObjectId,
  stableJson
} = require("./store-utils");

const SCHEMA_VERSION = 1;
const RELEASE_LOOKUP_CHUNK_SIZE = 900;
const RELAY_PAGE_MAXIMUM = 10000;
const states = new WeakMap();

const schema = `
  CREATE TABLE IF NOT EXISTS fns_store_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    source TEXT NOT NULL,
    snapshot TEXT,
    data_revision INTEGER NOT NULL CHECK (data_revision >= 0)
  );

  CREATE TABLE IF NOT EXISTS fns_store_objects (
    object_id TEXT PRIMARY KEY,
    object_json TEXT NOT NULL,
    payload_type TEXT,
    bind_context TEXT,
    bind_alias TEXT,
    release_binding TEXT,
    commune_context TEXT
  );

  CREATE INDEX IF NOT EXISTS fns_store_bindings_index
    ON fns_store_objects (payload_type, bind_context, bind_alias, object_id);
  CREATE INDEX IF NOT EXISTS fns_store_releases_index
    ON fns_store_objects (payload_type, release_binding, object_id);
  CREATE INDEX IF NOT EXISTS fns_store_commune_index
    ON fns_store_objects (payload_type, commune_context, object_id);

  CREATE TABLE IF NOT EXISTS fns_store_coverage (
    method TEXT NOT NULL CHECK (method IN ('bindings', 'releases', 'communeDocuments')),
    scope_json TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    PRIMARY KEY (method, scope_json)
  );
`;

function assertOptionsObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InvalidRequestError(`${name} must be an object`);
}

function validateStoreOptions(options) {
  assertOptionsObject(options, "SQLiteStore options");
  const { filename, readonly = false, source, snapshot, timeout = 5000 } = options;
  if (typeof filename !== "string" || filename.length === 0)
    throw new InvalidRequestError("filename must be a non-empty string", { filename });
  if (typeof readonly !== "boolean") throw new InvalidRequestError("readonly must be a boolean", { readonly });
  if (source !== undefined && typeof source !== "string")
    throw new InvalidRequestError("source must be a string", { source });
  if (snapshot !== undefined && snapshot !== null && typeof snapshot !== "string")
    throw new InvalidRequestError("snapshot must be a string or null", { snapshot });
  if (!Number.isSafeInteger(timeout) || timeout < 0)
    throw new InvalidRequestError("timeout must be a non-negative integer", { timeout });

  return {
    filename,
    readonly,
    source: source === undefined ? defaultSource(filename) : source,
    snapshot: snapshot === undefined ? null : snapshot,
    timeout
  };
}

function defaultSource(filename) {
  return filename === ":memory:" ? "sqlite:memory" : `sqlite:${path.resolve(filename)}`;
}

function stateFor(store) {
  const state = states.get(store);
  if (!state) throw new StoreAccessError("SQLiteStore is not initialized");
  if (state.closed) throw new StoreAccessError("SQLiteStore is closed");
  return state;
}

function mapDatabaseError(error, message) {
  if (error instanceof InvalidRequestError || error instanceof StoreAccessError || error instanceof StoreIntegrityError)
    return error;
  return new StoreAccessError(message, { reason: error instanceof Error ? error.message : String(error) });
}

function withDatabaseError(message, action) {
  try {
    return action();
  } catch (error) {
    throw mapDatabaseError(error, message);
  }
}

function withImmediateTransaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original failure is the useful error for callers.
    }
    throw error;
  }
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function assertSchema(db) {
  const requiredColumns = {
    fns_store_metadata: ["id", "schema_version", "source", "snapshot", "data_revision"],
    fns_store_objects: [
      "object_id",
      "object_json",
      "payload_type",
      "bind_context",
      "bind_alias",
      "release_binding",
      "commune_context"
    ],
    fns_store_coverage: ["method", "scope_json", "complete", "revision"]
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const actual = tableColumns(db, table);
    if (expected.some((column) => !actual.includes(column)))
      throw new StoreIntegrityError("SQLite store schema is incomplete", { table, expected, actual });
  }
}

function schemaVersion(db) {
  const version = db.pragma("user_version", { simple: true });
  if (!Number.isSafeInteger(version) || version < 0)
    throw new StoreIntegrityError("SQLite store has an invalid schema version", { version });
  return version;
}

function migrate(db, initialMetadata) {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION)
    throw new StoreIntegrityError("SQLite store schema is newer than this package", {
      actual: version,
      supported: SCHEMA_VERSION
    });
  if (version === SCHEMA_VERSION) {
    assertSchema(db);
    readMetadata(db);
    return;
  }

  withImmediateTransaction(db, () => {
    db.exec(schema);
    assertSchema(db);
    const metadata = db.prepare("SELECT id FROM fns_store_metadata WHERE id = 1").get();
    if (metadata) {
      throw new StoreIntegrityError("SQLite store metadata exists without a schema version");
    }
    db.prepare(
      `INSERT INTO fns_store_metadata (id, schema_version, source, snapshot, data_revision)
       VALUES (1, ?, ?, ?, 0)`
    ).run(SCHEMA_VERSION, initialMetadata.source, initialMetadata.snapshot);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
}

function ensureReadonlySchema(db) {
  const version = schemaVersion(db);
  if (version !== SCHEMA_VERSION)
    throw new StoreIntegrityError("SQLite store schema is not readable by this package", {
      actual: version,
      supported: SCHEMA_VERSION
    });
  assertSchema(db);
  readMetadata(db);
}

function readMetadata(db) {
  const metadata = db
    .prepare("SELECT schema_version, source, snapshot, data_revision FROM fns_store_metadata WHERE id = 1")
    .get();
  if (!metadata) throw new StoreIntegrityError("SQLite store metadata is missing");
  if (
    metadata.schema_version !== SCHEMA_VERSION ||
    typeof metadata.source !== "string" ||
    (metadata.snapshot !== null && typeof metadata.snapshot !== "string") ||
    !Number.isSafeInteger(metadata.data_revision) ||
    metadata.data_revision < 0
  )
    throw new StoreIntegrityError("SQLite store metadata is invalid", { metadata });
  return {
    source: metadata.source,
    snapshot: metadata.snapshot,
    dataRevision: metadata.data_revision
  };
}

function deriveIndexes(object) {
  const payload =
    object !== null && typeof object === "object" && !Array.isArray(object) && object.payload !== null
      ? object.payload
      : null;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return {
      payloadType: null,
      bindContext: null,
      bindAlias: null,
      releaseBinding: null,
      communeContext: null
    };

  const payloadType = typeof payload.type === "string" ? payload.type : null;
  return {
    payloadType,
    bindContext: payloadType === "fns.alias.bind" && typeof payload.context === "string" ? payload.context : null,
    bindAlias: payloadType === "fns.alias.bind" && typeof payload.alias === "string" ? payload.alias : null,
    releaseBinding: payloadType === "fns.alias.release" && typeof payload.binding === "string" ? payload.binding : null,
    communeContext: payloadType === "fns.commune.update" && typeof payload.commune === "string" ? payload.commune : null
  };
}

function normalizeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    throw new InvalidRequestError("entry must be an object");
  const { objectId, object } = entry;
  requireObjectId(objectId);
  if (!hasOwn(entry, "object")) throw new InvalidRequestError("object is required", { objectId });
  assertJsonValue(object, "object", { objectId });
  const objectJson = stableJson(object);
  return { objectId, objectJson, ...deriveIndexes(object) };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new InvalidRequestError("entries must be an array", { entries });
  const byId = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    const previous = byId.get(normalized.objectId);
    if (previous && previous.objectJson !== normalized.objectJson)
      throw new StoreIntegrityError("one ObjectId has conflicting imported representations", {
        objectId: normalized.objectId
      });
    byId.set(normalized.objectId, normalized);
  }
  return [...byId.values()].sort((left, right) => compareText(left.objectId, right.objectId));
}

function normalizeScope(method, scope) {
  assertOptionsObject(scope, "scope");
  if (method === "bindings") {
    const { context, alias } = scope;
    requireObjectId(context, "context");
    if (typeof alias !== "string") throw new InvalidRequestError("alias must be a string", { alias });
    return { context, alias };
  }
  if (method === "releases") {
    if (!Array.isArray(scope.bindingIds))
      throw new InvalidRequestError("bindingIds must be an array", { bindingIds: scope.bindingIds });
    const bindingIds = [...new Set(scope.bindingIds)];
    bindingIds.forEach((bindingId) => requireObjectId(bindingId, "bindingId"));
    bindingIds.sort(compareText);
    return { bindingIds };
  }
  if (method === "communeDocuments") {
    const { context } = scope;
    requireObjectId(context, "context");
    return { context };
  }
  throw new InvalidRequestError("method is not supported", { method });
}

function normalizeCoverage(coverage) {
  if (!Array.isArray(coverage)) throw new InvalidRequestError("coverage must be an array", { coverage });
  const entries = new Map();
  for (const entry of coverage) {
    assertOptionsObject(entry, "coverage entry");
    const { method, scope, complete } = entry;
    if (!METHOD_NAMES.has(method) || typeof complete !== "boolean")
      throw new InvalidRequestError("coverage entry must contain a known method and boolean complete", {
        method,
        complete
      });
    const normalizedScope = normalizeScope(method, scope);
    const scopeJson = stableJson(normalizedScope);
    const key = `${method}\u0000${scopeJson}`;
    if (entries.has(key) && entries.get(key).complete !== complete)
      throw new InvalidRequestError("coverage contains conflicting entries", { method, scope: normalizedScope });
    entries.set(key, { method, scopeJson, complete });
  }
  return [...entries.values()];
}

function normalizeImportRequest(input) {
  assertOptionsObject(input, "import options");
  const { entries, coverage = [], replace = true, source, snapshot } = input;
  if (typeof replace !== "boolean") throw new InvalidRequestError("replace must be a boolean", { replace });
  if (source !== undefined && typeof source !== "string")
    throw new InvalidRequestError("source must be a string", { source });
  if (snapshot !== undefined && snapshot !== null && typeof snapshot !== "string")
    throw new InvalidRequestError("snapshot must be a string or null", { snapshot });
  return {
    entries: normalizeEntries(entries),
    coverage: normalizeCoverage(coverage),
    replace,
    source,
    snapshot
  };
}

function parseStoredEntry(row) {
  if (!row || typeof row.object_id !== "string" || !isCanonicalObjectId(row.object_id))
    throw new StoreIntegrityError("SQLite store has an invalid stored ObjectId", { objectId: row?.object_id });
  if (typeof row.object_json !== "string")
    throw new StoreIntegrityError("SQLite store has an invalid stored object representation", {
      objectId: row.object_id
    });
  let object;
  try {
    object = JSON.parse(row.object_json);
  } catch {
    throw new StoreIntegrityError("SQLite store has malformed JSON", { objectId: row.object_id });
  }
  if (!isJsonValue(object) || stableJson(object) !== row.object_json)
    throw new StoreIntegrityError("SQLite store has a non-canonical JSON object", { objectId: row.object_id });
  const indexes = deriveIndexes(object);
  const actual = {
    payloadType: row.payload_type,
    bindContext: row.bind_context,
    bindAlias: row.bind_alias,
    releaseBinding: row.release_binding,
    communeContext: row.commune_context
  };
  if (Object.keys(indexes).some((key) => indexes[key] !== actual[key]))
    throw new StoreIntegrityError("SQLite store discovery indexes do not match the stored object", {
      objectId: row.object_id
    });
  return candidate(row.object_id, object);
}

function readComplete(state, metadata, method, scope) {
  const scopeJson = stableJson(scope);
  const coverage = state.db
    .prepare("SELECT complete, revision FROM fns_store_coverage WHERE method = ? AND scope_json = ?")
    .get(method, scopeJson);
  if (!coverage) return false;
  if (
    (coverage.complete !== 0 && coverage.complete !== 1) ||
    !Number.isSafeInteger(coverage.revision) ||
    coverage.revision < 0 ||
    coverage.revision > metadata.dataRevision
  )
    throw new StoreIntegrityError("SQLite store coverage entry is invalid", { method, scope });
  return coverage.complete === 1 && coverage.revision === metadata.dataRevision;
}

function parseCoverageRow(row, metadata) {
  if (!row || !METHOD_NAMES.has(row.method))
    throw new StoreIntegrityError("SQLite store has an unknown coverage method");
  if (typeof row.scope_json !== "string")
    throw new StoreIntegrityError("SQLite store has an invalid coverage representation", { method: row.method });
  let scope;
  try {
    scope = JSON.parse(row.scope_json);
  } catch {
    throw new StoreIntegrityError("SQLite store has malformed coverage JSON", { method: row.method });
  }
  let normalizedScope;
  try {
    normalizedScope = normalizeScope(row.method, scope);
  } catch {
    throw new StoreIntegrityError("SQLite store has invalid coverage scope", { method: row.method });
  }
  if (stableJson(normalizedScope) !== row.scope_json)
    throw new StoreIntegrityError("SQLite store has non-canonical coverage JSON", { method: row.method });
  if (
    (row.complete !== 0 && row.complete !== 1) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    row.revision > metadata.dataRevision
  )
    throw new StoreIntegrityError("SQLite store has invalid coverage metadata", { method: row.method });
  return { method: row.method, scope: normalizedScope, complete: row.complete === 1, revision: row.revision };
}

function envelope(metadata, method, scope, objects, complete) {
  const warnings = complete
    ? []
    : [{ code: "W_STORE_DISCOVERY_INCOMPLETE", message: `${method} discovery is incomplete`, detail: { method } }];
  return {
    version: DISCOVERY_VERSION,
    objects: objects.sort(byObjectId),
    complete,
    provenance: [{ source: metadata.source, snapshot: metadata.snapshot, scope: cloneJson(scope), complete }],
    warnings: warnings.sort(byDiagnostic)
  };
}

function normalizeRelayPage(page) {
  assertOptionsObject(page, "Relay page options");
  const { afterObjectId = null, limit } = page;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RELAY_PAGE_MAXIMUM)
    throw new InvalidRequestError("Relay page limit is invalid", { limit, maximum: RELAY_PAGE_MAXIMUM });
  if (afterObjectId !== null) requireObjectId(afterObjectId, "afterObjectId");
  return { afterObjectId, limit };
}

function relayPageEnvelope(metadata, method, scope, rows, complete, limit) {
  const hasMore = rows.length > limit;
  const objects = rows.slice(0, limit).map(parseStoredEntry);
  return { ...envelope(metadata, method, scope, objects, complete), hasMore };
}

function findAliasBindingsPage(store, context, alias, page) {
  const scope = normalizeScope("bindings", { context, alias });
  const { afterObjectId, limit } = normalizeRelayPage(page);
  const state = stateFor(store);
  return withDatabaseError("unable to page SQLite alias bindings", () =>
    state.db.transaction(() => {
      const metadata = readMetadata(state.db);
      const afterClause = afterObjectId === null ? "" : " AND object_id COLLATE BINARY > ?";
      const parameters =
        afterObjectId === null
          ? [scope.context, scope.alias, limit + 1]
          : [scope.context, scope.alias, afterObjectId, limit + 1];
      const rows = state.db
        .prepare(
          `SELECT * FROM fns_store_objects
            WHERE payload_type = 'fns.alias.bind' AND bind_context = ? AND bind_alias = ?${afterClause}
            ORDER BY object_id COLLATE BINARY
            LIMIT ?`
        )
        .all(...parameters);
      return relayPageEnvelope(
        metadata,
        "bindings",
        scope,
        rows,
        readComplete(state, metadata, "bindings", scope),
        limit
      );
    })()
  );
}

function findAliasReleasesPage(store, bindingIds, page) {
  const scope = normalizeScope("releases", { bindingIds });
  const { afterObjectId, limit } = normalizeRelayPage(page);
  if (scope.bindingIds.length > RELEASE_LOOKUP_CHUNK_SIZE)
    throw new InvalidRequestError("Relay page release lookup has too many binding IDs", {
      maximum: RELEASE_LOOKUP_CHUNK_SIZE
    });
  const state = stateFor(store);
  return withDatabaseError("unable to page SQLite alias releases", () =>
    state.db.transaction(() => {
      const metadata = readMetadata(state.db);
      if (scope.bindingIds.length === 0)
        return relayPageEnvelope(
          metadata,
          "releases",
          scope,
          [],
          readComplete(state, metadata, "releases", scope),
          limit
        );
      const placeholders = scope.bindingIds.map(() => "?").join(", ");
      const afterClause = afterObjectId === null ? "" : " AND object_id COLLATE BINARY > ?";
      const parameters =
        afterObjectId === null ? [...scope.bindingIds, limit + 1] : [...scope.bindingIds, afterObjectId, limit + 1];
      const rows = state.db
        .prepare(
          `SELECT * FROM fns_store_objects
            WHERE payload_type = 'fns.alias.release' AND release_binding IN (${placeholders})${afterClause}
            ORDER BY object_id COLLATE BINARY
            LIMIT ?`
        )
        .all(...parameters);
      return relayPageEnvelope(
        metadata,
        "releases",
        scope,
        rows,
        readComplete(state, metadata, "releases", scope),
        limit
      );
    })()
  );
}

function findCommuneDocumentsPage(store, context, page) {
  const scope = normalizeScope("communeDocuments", { context });
  const { afterObjectId, limit } = normalizeRelayPage(page);
  const state = stateFor(store);
  return withDatabaseError("unable to page SQLite commune documents", () =>
    state.db.transaction(() => {
      const metadata = readMetadata(state.db);
      const afterClause = afterObjectId === null ? "" : " AND object_id COLLATE BINARY > ?";
      const parameters =
        afterObjectId === null
          ? [scope.context, scope.context, limit + 1]
          : [scope.context, scope.context, afterObjectId, limit + 1];
      const rows = state.db
        .prepare(
          `SELECT * FROM fns_store_objects
            WHERE (object_id = ? OR (payload_type = 'fns.commune.update' AND commune_context = ?))${afterClause}
            ORDER BY object_id COLLATE BINARY
            LIMIT ?`
        )
        .all(...parameters);
      return relayPageEnvelope(
        metadata,
        "communeDocuments",
        scope,
        rows,
        readComplete(state, metadata, "communeDocuments", scope),
        limit
      );
    })()
  );
}

function requireWritable(state) {
  if (state.readonly) throw new StoreAccessError("SQLite store is read-only");
}

function insertEntry(db, entry) {
  db.prepare(
    `INSERT INTO fns_store_objects
      (object_id, object_json, payload_type, bind_context, bind_alias, release_binding, commune_context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.objectId,
    entry.objectJson,
    entry.payloadType,
    entry.bindContext,
    entry.bindAlias,
    entry.releaseBinding,
    entry.communeContext
  );
}

function assertNoStoredConflict(db, entry) {
  const existing = db
    .prepare("SELECT object_id, object_json FROM fns_store_objects WHERE object_id = ?")
    .get(entry.objectId);
  if (existing && existing.object_json !== entry.objectJson)
    throw new StoreIntegrityError("one ObjectId has conflicting stored representations", { objectId: entry.objectId });
  return Boolean(existing);
}

function updateMetadata(db, metadata) {
  db.prepare(
    `UPDATE fns_store_metadata
        SET source = ?, snapshot = ?, data_revision = ?
      WHERE id = 1`
  ).run(metadata.source, metadata.snapshot, metadata.dataRevision);
}

function insertCoverage(db, coverage, revision) {
  const statement = db.prepare(
    `INSERT INTO fns_store_coverage (method, scope_json, complete, revision)
     VALUES (?, ?, ?, ?)`
  );
  for (const entry of coverage) statement.run(entry.method, entry.scopeJson, entry.complete ? 1 : 0, revision);
}

function importSnapshot(store, input) {
  const request = normalizeImportRequest(input);
  const state = stateFor(store);
  requireWritable(state);
  return withDatabaseError("unable to import SQLite snapshot", () =>
    withImmediateTransaction(state.db, () => {
      const current = readMetadata(state.db);
      const next = {
        source: request.source === undefined ? current.source : request.source,
        snapshot: request.snapshot === undefined ? current.snapshot : request.snapshot,
        dataRevision: current.dataRevision + 1
      };
      if (request.replace) state.db.exec("DELETE FROM fns_store_objects");
      for (const entry of request.entries) {
        if (!assertNoStoredConflict(state.db, entry)) insertEntry(state.db, entry);
      }
      state.db.exec("DELETE FROM fns_store_coverage");
      insertCoverage(state.db, request.coverage, next.dataRevision);
      updateMetadata(state.db, next);
      return { dataRevision: next.dataRevision, objects: request.entries.length };
    })
  );
}

function appendEntries(store, entries) {
  const normalizedEntries = normalizeEntries(entries);
  const state = stateFor(store);
  requireWritable(state);
  return withDatabaseError("unable to append SQLite entries", () =>
    withImmediateTransaction(state.db, () => {
      const current = readMetadata(state.db);
      let inserted = 0;
      for (const entry of normalizedEntries) {
        if (!assertNoStoredConflict(state.db, entry)) {
          insertEntry(state.db, entry);
          inserted += 1;
        }
      }
      if (inserted === 0) return { dataRevision: current.dataRevision, inserted };
      const next = { ...current, dataRevision: current.dataRevision + 1 };
      state.db.exec("DELETE FROM fns_store_coverage");
      updateMetadata(state.db, next);
      return { dataRevision: next.dataRevision, inserted };
    })
  );
}

function setCoverage(store, method, scope, complete) {
  if (!METHOD_NAMES.has(method) || typeof complete !== "boolean")
    throw new InvalidRequestError("method and boolean completeness are required", { method, complete });
  const normalizedScope = normalizeScope(method, scope);
  const state = stateFor(store);
  requireWritable(state);
  return withDatabaseError("unable to set SQLite coverage", () => {
    const metadata = readMetadata(state.db);
    state.db
      .prepare(
        `INSERT INTO fns_store_coverage (method, scope_json, complete, revision)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(method, scope_json)
         DO UPDATE SET complete = excluded.complete, revision = excluded.revision`
      )
      .run(method, stableJson(normalizedScope), complete ? 1 : 0, metadata.dataRevision);
  });
}

function backup(store, destination) {
  if (typeof destination !== "string" || destination.length === 0)
    throw new InvalidRequestError("destination must be a non-empty string", { destination });
  const state = stateFor(store);
  try {
    return state.db.backup(destination).catch((error) => {
      throw mapDatabaseError(error, "unable to back up SQLite store");
    });
  } catch (error) {
    throw mapDatabaseError(error, "unable to back up SQLite store");
  }
}

function verifyIntegrity(store) {
  const state = stateFor(store);
  return withDatabaseError("unable to verify SQLite store integrity", () => {
    assertSchema(state.db);
    const metadata = readMetadata(state.db);
    const result = state.db.pragma("integrity_check")[0];
    if (!result || result.integrity_check !== "ok")
      throw new StoreIntegrityError("SQLite integrity check failed", { result });
    for (const row of state.db.prepare("SELECT * FROM fns_store_objects ORDER BY object_id").iterate())
      parseStoredEntry(row);
    for (const row of state.db
      .prepare("SELECT method, scope_json, complete, revision FROM fns_store_coverage")
      .iterate())
      parseCoverageRow(row, metadata);
    const objectCount = state.db.prepare("SELECT COUNT(*) AS count FROM fns_store_objects").get().count;
    return { schemaVersion: SCHEMA_VERSION, dataRevision: metadata.dataRevision, objectCount };
  });
}

function exportSnapshot(store) {
  const state = stateFor(store);
  return withDatabaseError("unable to export SQLite snapshot", () =>
    state.db.transaction(() => {
      const metadata = readMetadata(state.db);
      const entries = state.db
        .prepare("SELECT * FROM fns_store_objects ORDER BY object_id COLLATE BINARY")
        .all()
        .map(parseStoredEntry);
      const coverage = state.db
        .prepare("SELECT method, scope_json, complete, revision FROM fns_store_coverage ORDER BY method, scope_json")
        .all()
        .map((row) => parseCoverageRow(row, metadata))
        .filter((entry) => entry.revision === metadata.dataRevision)
        .map(({ method, scope, complete }) => ({ method, scope, complete }));
      return {
        version: "fns.store-export.v1",
        source: metadata.source,
        snapshot: metadata.snapshot,
        dataRevision: metadata.dataRevision,
        entries,
        coverage
      };
    })()
  );
}

/**
 * Persistent FnsStore implementation backed by a local SQLite file. Its public
 * FnsStore surface is read-only; imports, coverage, and backup are intentionally
 * kept on SQLiteStoreAdmin so they do not expand Store Interface v0.
 */
class SQLiteStore extends FnsStore {
  constructor(options) {
    super();
    const normalized = validateStoreOptions(options);
    let db;
    try {
      db = new Database(normalized.filename, {
        readonly: normalized.readonly,
        fileMustExist: normalized.readonly,
        timeout: normalized.timeout
      });
      db.pragma("foreign_keys = ON");
      if (normalized.readonly) ensureReadonlySchema(db);
      else {
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = FULL");
        migrate(db, normalized);
      }
      states.set(this, { db, readonly: normalized.readonly, closed: false });
    } catch (error) {
      try {
        if (db) db.close();
      } catch {
        // Prefer the opening or migration error below.
      }
      throw mapDatabaseError(error, "unable to open SQLite store");
    }
  }

  async getObject(objectId) {
    requireObjectId(objectId);
    const state = stateFor(this);
    return withDatabaseError("unable to read SQLite object", () => {
      const row = state.db.prepare("SELECT * FROM fns_store_objects WHERE object_id = ?").get(objectId);
      return row ? parseStoredEntry(row) : null;
    });
  }

  async findAliasBindings(context, alias) {
    const scope = normalizeScope("bindings", { context, alias });
    const state = stateFor(this);
    return withDatabaseError("unable to find SQLite alias bindings", () => {
      const metadata = readMetadata(state.db);
      const objects = state.db
        .prepare(
          `SELECT * FROM fns_store_objects
            WHERE payload_type = 'fns.alias.bind' AND bind_context = ? AND bind_alias = ?
            ORDER BY object_id COLLATE BINARY`
        )
        .all(scope.context, scope.alias)
        .map(parseStoredEntry);
      return envelope(metadata, "bindings", scope, objects, readComplete(state, metadata, "bindings", scope));
    });
  }

  async findAliasReleases(bindingIds) {
    const scope = normalizeScope("releases", { bindingIds });
    const state = stateFor(this);
    return withDatabaseError("unable to find SQLite alias releases", () => {
      const metadata = readMetadata(state.db);
      const objects = [];
      for (let offset = 0; offset < scope.bindingIds.length; offset += RELEASE_LOOKUP_CHUNK_SIZE) {
        const chunk = scope.bindingIds.slice(offset, offset + RELEASE_LOOKUP_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = state.db
          .prepare(
            `SELECT * FROM fns_store_objects
              WHERE payload_type = 'fns.alias.release' AND release_binding IN (${placeholders})
              ORDER BY object_id COLLATE BINARY`
          )
          .all(...chunk);
        objects.push(...rows.map(parseStoredEntry));
      }
      return envelope(metadata, "releases", scope, objects, readComplete(state, metadata, "releases", scope));
    });
  }

  async findCommuneDocuments(context) {
    const scope = normalizeScope("communeDocuments", { context });
    const state = stateFor(this);
    return withDatabaseError("unable to find SQLite commune documents", () => {
      const metadata = readMetadata(state.db);
      const objects = state.db
        .prepare(
          `SELECT * FROM fns_store_objects
            WHERE object_id = ? OR (payload_type = 'fns.commune.update' AND commune_context = ?)
            ORDER BY object_id COLLATE BINARY`
        )
        .all(scope.context, scope.context)
        .map(parseStoredEntry);
      return envelope(
        metadata,
        "communeDocuments",
        scope,
        objects,
        readComplete(state, metadata, "communeDocuments", scope)
      );
    });
  }

  close() {
    const state = states.get(this);
    if (!state || state.closed) return;
    try {
      state.db.close();
      state.closed = true;
    } catch (error) {
      throw mapDatabaseError(error, "unable to close SQLite store");
    }
  }
}

/** Administrative management API outside the frozen FnsStore v0 read contract. */
class SQLiteStoreAdmin {
  constructor(store) {
    if (!(store instanceof SQLiteStore))
      throw new InvalidRequestError("SQLiteStoreAdmin requires a SQLiteStore instance");
    stateFor(store);
    this.store = store;
  }

  importSnapshot(input) {
    return importSnapshot(this.store, input);
  }

  appendEntries(entries) {
    return appendEntries(this.store, entries);
  }

  setCoverage(method, scope, complete) {
    return setCoverage(this.store, method, scope, complete);
  }

  backup(destination) {
    return backup(this.store, destination);
  }

  verifyIntegrity() {
    return verifyIntegrity(this.store);
  }

  exportSnapshot() {
    return exportSnapshot(this.store);
  }

  findAliasBindingsPage(context, alias, page) {
    return findAliasBindingsPage(this.store, context, alias, page);
  }

  findAliasReleasesPage(bindingIds, page) {
    return findAliasReleasesPage(this.store, bindingIds, page);
  }

  findCommuneDocumentsPage(context, page) {
    return findCommuneDocumentsPage(this.store, context, page);
  }
}

module.exports = { SCHEMA_VERSION, SQLiteStore, SQLiteStoreAdmin };
