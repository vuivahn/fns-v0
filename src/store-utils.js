"use strict";

const { InvalidRequestError } = require("./errors");

const OBJECT_ID = /^fns:obj:sha256:[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PREFIX = "fns:obj:sha256:";
const METHOD_NAMES = new Set(["bindings", "releases", "communeDocuments"]);
const DISCOVERY_VERSION = "fns.store-discovery.v0";
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
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !hasOwn(descriptor, "value") ||
          !isJsonValue(descriptor.value, seen)
        )
          return false;
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
  return `{${Object.keys(value)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`)
    .join(",")}}`;
}

function cloneJson(value) {
  if (!isJsonValue(value)) throw new TypeError("value must be a JSON value");
  return JSON.parse(JSON.stringify(value));
}

function byObjectId(left, right) {
  return compareText(left.objectId, right.objectId);
}

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
  if (!isCanonicalObjectId(objectId))
    throw new InvalidRequestError(`${name} must be a canonical ObjectId`, { [name]: objectId });
}

function candidate(objectId, object) {
  return { objectId, object: cloneJson(object) };
}

module.exports = {
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
};
