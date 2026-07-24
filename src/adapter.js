"use strict";

const { resolveAlias } = require("fns-v0-validator");
const { InvalidRequestError, StoreIntegrityError } = require("./errors");
const {
  stableJson,
  cloneJson,
  byDiagnostic,
  byObjectId,
  compareText,
  isCanonicalObjectId,
  isJsonValue,
  requireObjectId
} = require("./memory-store");

const DISCOVERY_VERSION = "fns.store-discovery.v0";
const STORE_METHODS = ["findAliasBindings", "findAliasReleases", "findCommuneDocuments"];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireQuery(query) {
  if (query === null || typeof query !== "object" || Array.isArray(query))
    throw new InvalidRequestError("query must be an object");
  const { context, alias } = query;
  requireObjectId(context, "context");
  if (typeof alias !== "string") throw new InvalidRequestError("alias must be a string", { alias });
  return { context, alias };
}

function requireStore(store) {
  const missing = STORE_METHODS.filter((method) => typeof store?.[method] !== "function");
  if (missing.length) throw new InvalidRequestError("store must implement the discovery methods", { missing });
}

function invalidStoreResponse(method, message, detail = {}) {
  throw new StoreIntegrityError(`store ${method} response ${message}`, { method, ...detail });
}

function normalizeCandidate(method, candidate, index) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !hasOwn(candidate, "objectId") ||
    !hasOwn(candidate, "object")
  ) {
    invalidStoreResponse(method, "contains an invalid Candidate", { index });
  }
  if (!isCanonicalObjectId(candidate.objectId))
    invalidStoreResponse(method, "contains a non-canonical ObjectId", { index });
  if (!isJsonValue(candidate.object)) invalidStoreResponse(method, "contains a non-JSON Candidate object", { index });
  return { objectId: candidate.objectId, object: cloneJson(candidate.object) };
}

function normalizeWarnings(method, warnings) {
  for (let index = 0; index < warnings.length; index += 1) {
    const warning = warnings[index];
    if (
      warning === null ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      typeof warning.code !== "string" ||
      !isJsonValue(warning)
    ) {
      invalidStoreResponse(method, "contains an invalid diagnostic", { index });
    }
  }
  return cloneJson(warnings).sort(byDiagnostic);
}

function normalizeEnvelope(method, envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    invalidStoreResponse(method, "is not an object");
  if (envelope.version !== DISCOVERY_VERSION) invalidStoreResponse(method, "has an unsupported version");
  if (!Array.isArray(envelope.objects)) invalidStoreResponse(method, "has non-array objects");
  if (typeof envelope.complete !== "boolean") invalidStoreResponse(method, "has non-boolean completeness");
  if (!Array.isArray(envelope.provenance) || !isJsonValue(envelope.provenance))
    invalidStoreResponse(method, "has invalid provenance");
  if (!Array.isArray(envelope.warnings)) invalidStoreResponse(method, "has invalid warnings");

  const objects = new Map();
  for (let index = 0; index < envelope.objects.length; index += 1) {
    const candidate = normalizeCandidate(method, envelope.objects[index], index);
    const prior = objects.get(candidate.objectId);
    if (objects.has(candidate.objectId) && stableJson(prior) !== stableJson(candidate.object)) {
      throw new StoreIntegrityError("store discovery returned conflicting representations for one ObjectId", {
        objectId: candidate.objectId
      });
    }
    objects.set(candidate.objectId, candidate.object);
  }

  return {
    version: DISCOVERY_VERSION,
    objects: [...objects.entries()]
      .map(([objectId, object]) => ({ objectId, object: cloneJson(object) }))
      .sort(byObjectId),
    complete: envelope.complete,
    provenance: cloneJson(envelope.provenance),
    warnings: normalizeWarnings(method, envelope.warnings)
  };
}

function addCandidate(map, candidate) {
  const prior = map.get(candidate.objectId);
  if (map.has(candidate.objectId) && stableJson(prior) !== stableJson(candidate.object)) {
    throw new StoreIntegrityError("store discovery returned conflicting representations for one ObjectId", {
      objectId: candidate.objectId
    });
  }
  map.set(candidate.objectId, cloneJson(candidate.object));
}

function flatten(envelopes) {
  const objects = new Map();
  for (const envelope of envelopes) for (const candidate of envelope.objects) addCandidate(objects, candidate);
  return Object.fromEntries([...objects.entries()].sort(([left], [right]) => compareText(left, right)));
}

function storeWarnings(envelopes) {
  const incomplete = envelopes
    .filter(({ envelope }) => !envelope.complete)
    .map(({ method }) => method)
    .sort(compareText);
  const forwarded = envelopes.flatMap(({ envelope }) => envelope.warnings.map((warning) => cloneJson(warning)));
  if (incomplete.length)
    forwarded.push({
      code: "W_STORE_DISCOVERY_INCOMPLETE",
      message: "one or more Store discovery operations are incomplete",
      detail: { methods: incomplete }
    });
  return forwarded.sort(byDiagnostic);
}

async function discoverFromStore(query, store) {
  const normalizedQuery = requireQuery(query);
  requireStore(store);
  const [rawBindings, rawCommuneDocuments] = await Promise.all([
    Promise.resolve().then(() => store.findAliasBindings(normalizedQuery.context, normalizedQuery.alias)),
    Promise.resolve().then(() => store.findCommuneDocuments(normalizedQuery.context))
  ]);
  const bindings = normalizeEnvelope("bindings", rawBindings);
  const bindingIds = bindings.objects.map((candidate) => candidate.objectId);
  const releases = normalizeEnvelope("releases", await store.findAliasReleases(bindingIds));
  const communeDocuments = normalizeEnvelope("communeDocuments", rawCommuneDocuments);
  const envelopes = [
    { method: "bindings", envelope: bindings },
    { method: "releases", envelope: releases },
    { method: "communeDocuments", envelope: communeDocuments }
  ];
  return {
    version: "fns.store-discovery-set.v0",
    query: normalizedQuery,
    bindings,
    releases,
    communeDocuments,
    objectStore: flatten(envelopes.map(({ envelope }) => envelope)),
    warnings: storeWarnings(envelopes)
  };
}

/**
 * Async bridge. It preserves the frozen synchronous resolveAlias result under
 * `resolution` and returns method-scoped Store diagnostics separately.
 */
async function resolveAliasFromStore(query, store, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new InvalidRequestError("options must be an object");
  if (
    options.discovery !== undefined &&
    options.discovery !== null &&
    (typeof options.discovery !== "object" || Array.isArray(options.discovery))
  ) {
    throw new InvalidRequestError("options.discovery must be an object when provided");
  }
  const discovery = await discoverFromStore(query, store);
  const coreOptions = {
    ...options,
    discovery: { ...(options.discovery || {}), complete: discovery.bindings.complete }
  };
  return {
    version: "fns.store-resolution.v0",
    resolution: resolveAlias(discovery.query, discovery.objectStore, coreOptions),
    storeDiscovery: {
      bindings: discovery.bindings,
      releases: discovery.releases,
      communeDocuments: discovery.communeDocuments
    },
    warnings: discovery.warnings
  };
}

module.exports = { discoverFromStore, resolveAliasFromStore };
