"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("../../../../src");
const { cloneJson, compareText, isJsonValue, requireObjectId, stableJson } = require("../../../../src/store-utils");
const { RelayProtocolError } = require("../../relay-contract/src/errors");
const { normalizeCandidate, normalizeCandidates } = require("../../relay-contract/src/validation");

const OBJECT_ID_PREFIX = "fns:obj:sha256:";
const BLOB_FILE = /^([A-Za-z0-9_-]{43})\.json$/;

function mapFileError(error, message) {
  if (
    error instanceof InvalidRequestError ||
    error instanceof StoreAccessError ||
    error instanceof StoreIntegrityError ||
    error instanceof RelayProtocolError
  )
    return error;
  return new StoreAccessError(message, { reason: error instanceof Error ? error.message : String(error) });
}

function digestFor(objectId) {
  requireObjectId(objectId);
  return objectId.slice(OBJECT_ID_PREFIX.length);
}

function writeDurableFile(filename, representation) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, "wx", 0o600);
    fs.writeFileSync(descriptor, representation, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  // Windows does not allow opening a directory handle this way. The file's
  // data is still flushed above; POSIX platforms also flush the link metadata.
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

class FileSystemBlobStore {
  constructor({ directory, readonly = false }) {
    if (typeof directory !== "string" || directory.length === 0)
      throw new InvalidRequestError("directory must be a non-empty string", { directory });
    if (typeof readonly !== "boolean") throw new InvalidRequestError("readonly must be a boolean", { readonly });
    this.directory = path.resolve(directory);
    this.readonly = readonly;
    try {
      if (readonly) {
        const information = fs.statSync(this.directory);
        if (!information.isDirectory()) throw new StoreAccessError("filesystem blob path is not a directory");
        fs.accessSync(this.directory, fs.constants.R_OK | fs.constants.X_OK);
      } else {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      }
    } catch (error) {
      throw mapFileError(error, "unable to initialize filesystem blob store");
    }
  }

  #filename(objectId) {
    return path.join(this.directory, `${digestFor(objectId)}.json`);
  }

  #read(objectId) {
    const filename = this.#filename(objectId);
    let representation;
    try {
      representation = fs.readFileSync(filename, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw mapFileError(error, "unable to read filesystem blob");
    }
    let object;
    try {
      object = JSON.parse(representation);
    } catch {
      throw new StoreIntegrityError("filesystem blob has malformed JSON", { objectId });
    }
    if (!isJsonValue(object) || stableJson(object) !== representation)
      throw new StoreIntegrityError("filesystem blob is not canonical JSON", { objectId });
    return { objectId, object: cloneJson(object) };
  }

  async putIfAbsent(value) {
    if (this.readonly) throw new StoreAccessError("filesystem blob store is read-only");
    const candidate = normalizeCandidate(value);
    const representation = stableJson(candidate.object);
    const existing = this.#read(candidate.objectId);
    if (existing) {
      if (stableJson(existing.object) !== representation)
        throw new StoreIntegrityError("one ObjectId has conflicting blob representations", {
          objectId: candidate.objectId
        });
      return existing;
    }

    const filename = this.#filename(candidate.objectId);
    const temporary = path.join(
      this.directory,
      `.${digestFor(candidate.objectId)}.${crypto.randomBytes(12).toString("hex")}.tmp`
    );
    try {
      writeDurableFile(temporary, representation);
      try {
        fs.linkSync(temporary, filename);
        syncDirectory(this.directory);
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        const concurrent = this.#read(candidate.objectId);
        if (!concurrent || stableJson(concurrent.object) !== representation)
          throw new StoreIntegrityError("one ObjectId has conflicting blob representations", {
            objectId: candidate.objectId
          });
        syncDirectory(this.directory);
      }
      return { objectId: candidate.objectId, object: cloneJson(candidate.object) };
    } catch (error) {
      throw mapFileError(error, "unable to write filesystem blob");
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A stale private temp file is recoverable; do not hide the write result.
      }
    }
  }

  async get(objectId) {
    return this.#read(objectId);
  }

  async exportBlobs(objectIds = null) {
    let ids;
    if (objectIds === null) {
      try {
        ids = fs
          .readdirSync(this.directory, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => BLOB_FILE.exec(entry.name))
          .filter(Boolean)
          .map((match) => `${OBJECT_ID_PREFIX}${match[1]}`);
      } catch (error) {
        throw mapFileError(error, "unable to list filesystem blobs");
      }
    } else {
      if (!Array.isArray(objectIds)) throw new RelayProtocolError("objectIds must be an array or null");
      ids = [...new Set(objectIds)];
      ids.forEach((objectId) => requireObjectId(objectId));
    }
    ids.sort(compareText);
    const blobs = [];
    for (const objectId of ids) {
      const blob = this.#read(objectId);
      if (!blob) throw new StoreIntegrityError("candidate blob is missing", { objectId });
      blobs.push(blob);
    }
    return blobs;
  }

  async restoreBlobs(blobs) {
    const normalized = normalizeCandidates(blobs);
    for (const blob of normalized) await this.putIfAbsent(blob);
    return { blobs: normalized.length };
  }

  async readiness() {
    try {
      fs.accessSync(
        this.directory,
        this.readonly
          ? fs.constants.R_OK | fs.constants.X_OK
          : fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
      );
      return { directory: "ok" };
    } catch (error) {
      throw mapFileError(error, "filesystem blob store is not ready");
    }
  }

  async verifyIntegrity() {
    const blobs = await this.exportBlobs();
    return { blobs: blobs.length };
  }
}

module.exports = { FileSystemBlobStore };
