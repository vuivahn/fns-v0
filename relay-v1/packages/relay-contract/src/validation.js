"use strict";

const {
  DISCOVERY_VERSION,
  METHOD_NAMES,
  assertJsonValue,
  cloneJson,
  compareText,
  hasOwn,
  requireObjectId,
  stableJson
} = require("../../../../src/store-utils");
const { RelayProtocolError } = require("./errors");

const STORE_EXPORT_VERSION = "fns.store-export.v1";

function assertObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RelayProtocolError(`${name} must be an object`);
}

function normalizeCandidate(value) {
  assertObject(value, "candidate");
  const { objectId, object } = value;
  try {
    requireObjectId(objectId);
    if (!hasOwn(value, "object")) throw new RelayProtocolError("candidate object is required", { objectId });
    assertJsonValue(object, "candidate object", { objectId });
  } catch (error) {
    if (error instanceof RelayProtocolError) throw error;
    throw new RelayProtocolError(error.message, error.detail ?? { objectId });
  }
  return { objectId, object: cloneJson(object) };
}

function normalizeCandidates(values) {
  if (!Array.isArray(values)) throw new RelayProtocolError("candidates must be an array");
  const candidates = new Map();
  for (const value of values) {
    const candidate = normalizeCandidate(value);
    const previous = candidates.get(candidate.objectId);
    if (previous && stableJson(previous.object) !== stableJson(candidate.object))
      throw new RelayProtocolError("one ObjectId has conflicting candidate representations", {
        objectId: candidate.objectId
      });
    candidates.set(candidate.objectId, candidate);
  }
  return [...candidates.values()].sort((left, right) => compareText(left.objectId, right.objectId));
}

function normalizeCoverageEntry(entry) {
  assertObject(entry, "coverage entry");
  const { method, scope, complete } = entry;
  if (!METHOD_NAMES.has(method) || typeof complete !== "boolean")
    throw new RelayProtocolError("coverage entry must contain a known method and boolean complete", {
      method,
      complete
    });
  assertObject(scope, "coverage scope");
  let normalizedScope;
  try {
    if (method === "bindings") {
      requireObjectId(scope.context, "context");
      if (typeof scope.alias !== "string") throw new RelayProtocolError("alias must be a string");
      normalizedScope = { context: scope.context, alias: scope.alias };
    } else if (method === "releases") {
      if (!Array.isArray(scope.bindingIds)) throw new RelayProtocolError("bindingIds must be an array");
      const bindingIds = [...new Set(scope.bindingIds)];
      bindingIds.forEach((bindingId) => requireObjectId(bindingId, "bindingId"));
      bindingIds.sort(compareText);
      normalizedScope = { bindingIds };
    } else {
      requireObjectId(scope.context, "context");
      normalizedScope = { context: scope.context };
    }
  } catch (error) {
    if (error instanceof RelayProtocolError) throw error;
    throw new RelayProtocolError(error.message, error.detail ?? { method });
  }
  return { method, scope: normalizedScope, complete };
}

function normalizeCoverage(entries) {
  if (!Array.isArray(entries)) throw new RelayProtocolError("coverage must be an array");
  const coverage = new Map();
  for (const entry of entries) {
    const normalized = normalizeCoverageEntry(entry);
    const key = `${normalized.method}\u0000${stableJson(normalized.scope)}`;
    if (coverage.has(key) && coverage.get(key).complete !== normalized.complete)
      throw new RelayProtocolError("coverage contains conflicting entries", { method: normalized.method });
    coverage.set(key, normalized);
  }
  return [...coverage.values()].sort((left, right) => {
    const byMethod = compareText(left.method, right.method);
    return byMethod === 0 ? compareText(stableJson(left.scope), stableJson(right.scope)) : byMethod;
  });
}

function normalizeStoreExport(value) {
  assertObject(value, "store export");
  const { version, source, snapshot, dataRevision, entries, coverage } = value;
  if (version !== STORE_EXPORT_VERSION)
    throw new RelayProtocolError("store export version is not supported", { version });
  if (typeof source !== "string") throw new RelayProtocolError("store export source must be a string", { source });
  if (snapshot !== null && typeof snapshot !== "string")
    throw new RelayProtocolError("store export snapshot must be a string or null", { snapshot });
  if (!Number.isSafeInteger(dataRevision) || dataRevision < 0)
    throw new RelayProtocolError("store export dataRevision must be a non-negative integer", { dataRevision });
  return {
    version: STORE_EXPORT_VERSION,
    source,
    snapshot,
    dataRevision,
    entries: normalizeCandidates(entries),
    coverage: normalizeCoverage(coverage)
  };
}

function assertDiscoveryEnvelope(value) {
  assertObject(value, "discovery envelope");
  if (value.version !== DISCOVERY_VERSION)
    throw new RelayProtocolError("discovery envelope version is not supported", { version: value.version });
  return value;
}

function assertRelayCandidateStore(store) {
  assertObject(store, "candidateStore");
  const requiredMethods = [
    "getObject",
    "findAliasBindings",
    "findAliasReleases",
    "findCommuneDocuments",
    "findAliasBindingsPage",
    "findAliasReleasesPage",
    "findCommuneDocumentsPage",
    "publishImmutable",
    "exportSnapshot",
    "restoreSnapshot",
    "readiness",
    "verifyIntegrity"
  ];
  for (const method of requiredMethods) {
    if (typeof store[method] !== "function")
      throw new RelayProtocolError("candidateStore does not implement the Relay contract", { method });
  }
  return store;
}

function assertRelayBlobStore(store) {
  assertObject(store, "blobStore");
  for (const method of ["putIfAbsent", "get", "exportBlobs", "restoreBlobs", "readiness", "verifyIntegrity"]) {
    if (typeof store[method] !== "function")
      throw new RelayProtocolError("blobStore does not implement the Relay contract", { method });
  }
  return store;
}

module.exports = {
  STORE_EXPORT_VERSION,
  assertDiscoveryEnvelope,
  assertRelayBlobStore,
  assertRelayCandidateStore,
  normalizeCandidate,
  normalizeCandidates,
  normalizeCoverage,
  normalizeStoreExport
};
