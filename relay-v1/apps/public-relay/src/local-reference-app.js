"use strict";

const fs = require("fs");
const path = require("path");
const { SQLiteStore } = require("../../../../src");
const { RelayProtocolError } = require("../../../packages/relay-contract/src/errors");
const {
  FileSystemBlobStore,
  LocalPublicationPolicy,
  LocalReferenceRelay,
  SQLiteCandidateStore,
  SQLiteCapabilityStore
} = require("../../../packages/relay-local/src");
const { createPublicRelayServer, normalizeSourceOfferUrl } = require("./server");

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new RelayProtocolError(`${name} must be set for the local Relay profile`);
  return value;
}

function readRequiredSecret(environment, name) {
  const direct = environment[name];
  const filename = environment[`${name}_FILE`];
  if (direct !== undefined && filename !== undefined)
    throw new RelayProtocolError(`${name} and ${name}_FILE cannot both be set`);
  if (filename === undefined) return requiredEnvironment(environment, name);
  if (typeof filename !== "string" || filename.length === 0)
    throw new RelayProtocolError(`${name}_FILE must be a non-empty filename`);
  let value;
  try {
    value = fs.readFileSync(filename);
  } catch {
    throw new RelayProtocolError(`${name}_FILE could not be read by the Relay process`);
  }
  let end = value.length;
  if (end > 0 && value[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && value[end - 1] === 0x0d) end -= 1;
  }
  if (end === 0) throw new RelayProtocolError(`${name}_FILE must not be empty`);
  return Buffer.from(value.subarray(0, end));
}

function optionalPositiveInteger(environment, name, fallback) {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new RelayProtocolError(`${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RelayProtocolError(`${name} is outside the supported range`);
  return number;
}

function sourceOfferUrl(environment, builtSourceOfferUrl) {
  const configured =
    environment.FNS_RELAY_SOURCE_OFFER_URL === undefined || environment.FNS_RELAY_SOURCE_OFFER_URL === ""
      ? null
      : normalizeSourceOfferUrl(environment.FNS_RELAY_SOURCE_OFFER_URL);
  const built = normalizeSourceOfferUrl(builtSourceOfferUrl);
  if (built !== null && configured !== null && built !== configured)
    throw new RelayProtocolError("FNS_RELAY_SOURCE_OFFER_URL does not match the source offer baked into this image");
  return built ?? configured;
}

function requireWritableDirectory(directory, name) {
  const resolved = path.resolve(directory);
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new RelayProtocolError(`${name} path must be readable, writable, and searchable by the Relay process`);
  }
  return resolved;
}

function requireWritableDatabaseFile(filename, name) {
  requireWritableDirectory(path.dirname(filename), `${name} parent directory`);
  try {
    if (fs.existsSync(filename)) fs.accessSync(filename, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new RelayProtocolError(`${name} must be readable and writable by the Relay process`);
  }
}

function prepareDataPaths({ candidateFilename, capabilityFilename, blobDirectory }) {
  requireWritableDatabaseFile(candidateFilename, "FNS_RELAY_CANDIDATES_DB");
  requireWritableDatabaseFile(capabilityFilename, "FNS_RELAY_CAPABILITY_DB");
  requireWritableDirectory(blobDirectory, "FNS_RELAY_BLOB_DIR");
}

function databaseIdentity(filename, name) {
  try {
    const canonical = fs.realpathSync.native(filename);
    const information = fs.statSync(filename);
    return { canonical, device: information.dev, inode: information.ino };
  } catch {
    throw new RelayProtocolError(`${name} must resolve to an accessible database file`);
  }
}

function assertDistinctDatabaseFiles(candidateFilename, capabilityFilename) {
  const candidate = databaseIdentity(candidateFilename, "FNS_RELAY_CANDIDATES_DB");
  const capability = databaseIdentity(capabilityFilename, "FNS_RELAY_CAPABILITY_DB");
  if (
    candidate.canonical === capability.canonical ||
    (candidate.device === capability.device && candidate.inode === capability.inode)
  )
    throw new RelayProtocolError("candidate and capability databases must resolve to distinct files");
}

function assertDistinctExistingDatabaseFiles(candidateFilename, capabilityFilename) {
  if (!fs.existsSync(candidateFilename) || !fs.existsSync(capabilityFilename)) return;
  assertDistinctDatabaseFiles(candidateFilename, capabilityFilename);
}

function createLocalReferenceRelayApplication({
  environment = process.env,
  now = () => Date.now(),
  builtSourceOfferUrl = null
} = {}) {
  if (!environment || typeof environment !== "object") throw new RelayProtocolError("environment must be an object");
  const candidateFilename = requiredEnvironment(environment, "FNS_RELAY_CANDIDATES_DB");
  const capabilityFilename = requiredEnvironment(environment, "FNS_RELAY_CAPABILITY_DB");
  if (path.resolve(candidateFilename) === path.resolve(capabilityFilename))
    throw new RelayProtocolError("candidate and capability databases must use separate files");
  const blobDirectory = requiredEnvironment(environment, "FNS_RELAY_BLOB_DIR");
  const capabilityPepper = readRequiredSecret(environment, "FNS_RELAY_CAPABILITY_PEPPER");
  const cursorSecret = readRequiredSecret(environment, "FNS_RELAY_CURSOR_SECRET");
  const source = environment.FNS_RELAY_SOURCE === undefined ? "sqlite:relay-local" : environment.FNS_RELAY_SOURCE;
  const snapshot = environment.FNS_RELAY_SNAPSHOT === undefined ? null : environment.FNS_RELAY_SNAPSHOT;
  const configuredSourceOfferUrl = sourceOfferUrl(environment, builtSourceOfferUrl);
  const maximumPageSize = optionalPositiveInteger(environment, "FNS_RELAY_MAX_PAGE_SIZE", 1000);
  const defaultPageSize = optionalPositiveInteger(environment, "FNS_RELAY_DEFAULT_PAGE_SIZE", 100);
  const maximumRequestBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_REQUEST_BYTES", 262144);
  const maximumResponseBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_RESPONSE_BYTES", 1048576);
  const maximumUrlBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_URL_BYTES", 8192);

  prepareDataPaths({ candidateFilename, capabilityFilename, blobDirectory });
  assertDistinctExistingDatabaseFiles(candidateFilename, capabilityFilename);
  const store = new SQLiteStore({ filename: candidateFilename, source, snapshot });
  let capabilityStore;
  try {
    const candidateStore = new SQLiteCandidateStore({ store });
    const blobStore = new FileSystemBlobStore({ directory: blobDirectory });
    capabilityStore = new SQLiteCapabilityStore({ filename: capabilityFilename, pepper: capabilityPepper, now });
    assertDistinctDatabaseFiles(candidateFilename, capabilityFilename);
    const relay = new LocalReferenceRelay({
      candidateStore,
      blobStore,
      capabilityVerifier: capabilityStore,
      publicationPolicy: new LocalPublicationPolicy()
    });
    const server = createPublicRelayServer({
      relay,
      cursorSecret,
      now,
      defaultPageSize,
      maximumPageSize,
      maximumRequestBytes,
      maximumResponseBytes,
      maximumUrlBytes,
      sourceOfferUrl: configuredSourceOfferUrl
    });
    let closed = false;
    return {
      server,
      relay,
      candidateStore,
      blobStore,
      capabilityStore,
      close() {
        if (closed) return;
        closed = true;
        capabilityStore.close();
        store.close();
      }
    };
  } catch (error) {
    if (capabilityStore) capabilityStore.close();
    store.close();
    throw error;
  }
}

module.exports = {
  createLocalReferenceRelayApplication,
  readRequiredSecret
};
