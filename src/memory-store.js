"use strict";

const { InvalidRequestError, StoreIntegrityError } = require("./errors");
const { FnsStore } = require("./fns-store");

const OBJECT_ID = /^fns:obj:sha256:[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PREFIX = "fns:obj:sha256:";
const METHOD_NAMES = new Set(["bindings", "releases", "communeDocuments"]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function compareText(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex);
    const rightCodePoint = right.codePointAt(rightIndex);
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  return leftIndex === left.length && rightIndex === right.length ? 0 : leftIndex === left.length ? -1 : 1;
}

function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value") || !isJsonValue(descriptor.value, seen)) return false;
      }
      return Reflect.ownKeys(value).every((key) => {
        if (key === "length") return true;
        if (typeof key !== "string") return false;
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key;
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && descriptor.enumerable && hasOwn(descriptor, "value") && isJsonValue(descriptor.value, seen);
    });
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function assertJsonValue(value, name, detail = null) {
  if (!isJsonValue(value)) throw new InvalidRequestError(`${name} must be a JSON value`, detail);
}

function stableJson(value) {
  if (!isJsonValue(value)) throw new TypeError("value must be a JSON value");
  return stableJsonValue(value);
}

function stableJsonValue(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`).join(",")}}`;
}

function cloneJson(value) {
  if (!isJsonValue(value)) throw new TypeError("value must be a JSON value");
  return JSON.parse(JSON.stringify(value));
}

function byObjectId(left, right) { return compareText(left.objectId, right.objectId); }
function byDiagnostic(left, right) {
  const leftDetail = hasOwn(left, "detail") ? left.detail : null;
  const rightDetail = hasOwn(right, "detail") ? right.detail : null;
  return compareText(`${left.code}\u0000${stableJson(leftDetail)}`, `${right.code}\u0000${stableJson(rightDetail)}`);
}

function isCanonicalObjectId(objectId) {
  if (typeof objectId !== "string" || !OBJECT_ID.test(objectId)) return false;
  const digest = objectId.slice(OBJECT_ID_PREFIX.length);
  try {
    const bytes = Buffer.from(digest, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === digest;
  } catch {
    return false;
  }
}

function requireObjectId(objectId, name = "objectId") {
  if (!isCanonicalObjectId(objectId)) throw new InvalidRequestError(`${name} must be a canonical ObjectId`, { [name]: objectId });
}

function candidate(objectId, object) { return { objectId, object: cloneJson(object) }; }

/**
 * Reference implementation of the read-only FnsStore interface. `put` and
 * `setCompleteness` exist only to construct deterministic fixtures; consumers
 * of the interface use the four async read methods below.
 */
class MemoryStore extends FnsStore {
  constructor(options = {}) {
    super();
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new InvalidRequestError("MemoryStore options must be an object");
    const { source = "memory:default", snapshot = null, completeness = {}, entries = [] } = options;
    if (typeof source !== "string") throw new InvalidRequestError("source must be a string", { source });
    if (snapshot !== null && typeof snapshot !== "string") throw new InvalidRequestError("snapshot must be a string or null", { snapshot });
    if (completeness === null || typeof completeness !== "object" || Array.isArray(completeness)) throw new InvalidRequestError("completeness must be an object", { completeness });
    const invalidCompleteness = Object.entries(completeness).find(([method, complete]) => !METHOD_NAMES.has(method) || typeof complete !== "boolean");
    if (invalidCompleteness) throw new InvalidRequestError("completeness must contain known methods with boolean values", { method: invalidCompleteness[0], complete: invalidCompleteness[1] });
    if (!Array.isArray(entries)) throw new InvalidRequestError("entries must be an array", { entries });
    this.source = source;
    this.snapshot = snapshot;
    this.records = new Map();
    this.completeness = { bindings: true, releases: true, communeDocuments: true, ...completeness };
    for (const entry of entries) this.put(entry);
  }

  put(entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new InvalidRequestError("entry must be an object");
    const { objectId, object } = entry;
    requireObjectId(objectId);
    if (!hasOwn(entry, "object")) throw new InvalidRequestError("object is required", { objectId });
    assertJsonValue(object, "object", { objectId });
    const representation = stableJson(object);
    const existing = this.records.get(objectId);
    if (existing) {
      if (existing.representation !== representation) throw new StoreIntegrityError("one ObjectId has conflicting stored representations", { objectId });
      return candidate(objectId, existing.object);
    }
    this.records.set(objectId, { object: cloneJson(object), representation });
    return candidate(objectId, object);
  }

  setCompleteness(method, complete) {
    if (!METHOD_NAMES.has(method) || typeof complete !== "boolean") throw new InvalidRequestError("method and boolean completeness are required", { method, complete });
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
    const objects = this.#all()
      .filter((entry) => entry.object?.payload?.type === "fns.alias.bind" && entry.object.payload.context === context && entry.object.payload.alias === alias);
    return this.#envelope("bindings", { context, alias }, objects);
  }

  async findAliasReleases(bindingIds) {
    if (!Array.isArray(bindingIds)) throw new InvalidRequestError("bindingIds must be an array", { bindingIds });
    const requested = [...new Set(bindingIds)];
    requested.forEach((id) => requireObjectId(id, "bindingId"));
    requested.sort(compareText);
    const bindings = new Set(requested);
    const objects = this.#all()
      .filter((entry) => entry.object?.payload?.type === "fns.alias.release" && bindings.has(entry.object.payload.binding));
    return this.#envelope("releases", { bindingIds: requested }, objects);
  }

  async findCommuneDocuments(context) {
    requireObjectId(context, "context");
    const objects = this.#all()
      .filter((entry) => entry.objectId === context || (entry.object?.payload?.type === "fns.commune.update" && entry.object.payload.commune === context));
    return this.#envelope("communeDocuments", { context }, objects);
  }

  #all() {
    return [...this.records.entries()].map(([objectId, record]) => candidate(objectId, record.object)).sort(byObjectId);
  }

  #envelope(method, scope, objects) {
    const complete = this.completeness[method] === true;
    const provenance = [{ source: this.source, snapshot: this.snapshot, scope: cloneJson(scope), complete }];
    const warnings = complete ? [] : [{ code: "W_STORE_DISCOVERY_INCOMPLETE", message: `${method} discovery is incomplete`, detail: { method } }];
    return { version: "fns.store-discovery.v0", objects: objects.sort(byObjectId), complete, provenance, warnings: warnings.sort(byDiagnostic) };
  }
}

module.exports = { MemoryStore, OBJECT_ID, compareText, isJsonValue, stableJson, cloneJson, byObjectId, byDiagnostic, isCanonicalObjectId, requireObjectId };
