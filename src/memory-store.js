"use strict";

const { InvalidRequestError, StoreIntegrityError } = require("./errors");
const { FnsStore } = require("./fns-store");
const {
  DISCOVERY_VERSION,
  METHOD_NAMES,
  OBJECT_ID,
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

/**
 * Reference implementation of the read-only FnsStore interface. `put` and
 * `setCompleteness` exist only to construct deterministic fixtures; consumers
 * of the interface use the four async read methods below.
 */
class MemoryStore extends FnsStore {
  constructor(options = {}) {
    super();
    if (options === null || typeof options !== "object" || Array.isArray(options))
      throw new InvalidRequestError("MemoryStore options must be an object");
    const { source = "memory:default", snapshot = null, completeness = {}, entries = [] } = options;
    if (typeof source !== "string") throw new InvalidRequestError("source must be a string", { source });
    if (snapshot !== null && typeof snapshot !== "string")
      throw new InvalidRequestError("snapshot must be a string or null", { snapshot });
    if (completeness === null || typeof completeness !== "object" || Array.isArray(completeness))
      throw new InvalidRequestError("completeness must be an object", { completeness });
    const invalidCompleteness = Object.entries(completeness).find(
      ([method, complete]) => !METHOD_NAMES.has(method) || typeof complete !== "boolean"
    );
    if (invalidCompleteness)
      throw new InvalidRequestError("completeness must contain known methods with boolean values", {
        method: invalidCompleteness[0],
        complete: invalidCompleteness[1]
      });
    if (!Array.isArray(entries)) throw new InvalidRequestError("entries must be an array", { entries });
    this.source = source;
    this.snapshot = snapshot;
    this.records = new Map();
    this.completeness = { bindings: true, releases: true, communeDocuments: true, ...completeness };
    for (const entry of entries) this.put(entry);
  }

  put(entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new InvalidRequestError("entry must be an object");
    const { objectId, object } = entry;
    requireObjectId(objectId);
    if (!hasOwn(entry, "object")) throw new InvalidRequestError("object is required", { objectId });
    assertJsonValue(object, "object", { objectId });
    const representation = stableJson(object);
    const existing = this.records.get(objectId);
    if (existing) {
      if (existing.representation !== representation)
        throw new StoreIntegrityError("one ObjectId has conflicting stored representations", { objectId });
      return candidate(objectId, existing.object);
    }
    this.records.set(objectId, { object: cloneJson(object), representation });
    return candidate(objectId, object);
  }

  setCompleteness(method, complete) {
    if (!METHOD_NAMES.has(method) || typeof complete !== "boolean")
      throw new InvalidRequestError("method and boolean completeness are required", { method, complete });
    this.completeness[method] = complete;
  }

  async getObject(objectId) {
    requireObjectId(objectId);
    const record = this.records.get(objectId);
    return record ? candidate(objectId, record.object) : null;
  }

  async findAliasBindings(context, alias) {
    requireObjectId(context, "context");
    if (typeof alias !== "string") throw new InvalidRequestError("alias must be a string", { alias });
    const objects = this.#all().filter(
      (entry) =>
        entry.object?.payload?.type === "fns.alias.bind" &&
        entry.object.payload.context === context &&
        entry.object.payload.alias === alias
    );
    return this.#envelope("bindings", { context, alias }, objects);
  }

  async findAliasReleases(bindingIds) {
    if (!Array.isArray(bindingIds)) throw new InvalidRequestError("bindingIds must be an array", { bindingIds });
    const requested = [...new Set(bindingIds)];
    requested.forEach((id) => requireObjectId(id, "bindingId"));
    requested.sort(compareText);
    const bindings = new Set(requested);
    const objects = this.#all().filter(
      (entry) => entry.object?.payload?.type === "fns.alias.release" && bindings.has(entry.object.payload.binding)
    );
    return this.#envelope("releases", { bindingIds: requested }, objects);
  }

  async findCommuneDocuments(context) {
    requireObjectId(context, "context");
    const objects = this.#all().filter(
      (entry) =>
        entry.objectId === context ||
        (entry.object?.payload?.type === "fns.commune.update" && entry.object.payload.commune === context)
    );
    return this.#envelope("communeDocuments", { context }, objects);
  }

  #all() {
    return [...this.records.entries()].map(([objectId, record]) => candidate(objectId, record.object)).sort(byObjectId);
  }

  #envelope(method, scope, objects) {
    const complete = this.completeness[method] === true;
    const provenance = [{ source: this.source, snapshot: this.snapshot, scope: cloneJson(scope), complete }];
    const warnings = complete
      ? []
      : [{ code: "W_STORE_DISCOVERY_INCOMPLETE", message: `${method} discovery is incomplete`, detail: { method } }];
    return {
      version: DISCOVERY_VERSION,
      objects: objects.sort(byObjectId),
      complete,
      provenance,
      warnings: warnings.sort(byDiagnostic)
    };
  }
}

module.exports = {
  MemoryStore,
  OBJECT_ID,
  compareText,
  isJsonValue,
  stableJson,
  cloneJson,
  byObjectId,
  byDiagnostic,
  isCanonicalObjectId,
  requireObjectId
};
