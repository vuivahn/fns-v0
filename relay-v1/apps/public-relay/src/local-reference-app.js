"use strict";

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
const { createPublicRelayServer } = require("./server");

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new RelayProtocolError(`${name} must be set for the local Relay profile`);
  return value;
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

function createLocalReferenceRelayApplication({ environment = process.env, now = () => Date.now() } = {}) {
  if (!environment || typeof environment !== "object") throw new RelayProtocolError("environment must be an object");
  const candidateFilename = requiredEnvironment(environment, "FNS_RELAY_CANDIDATES_DB");
  const capabilityFilename = requiredEnvironment(environment, "FNS_RELAY_CAPABILITY_DB");
  if (path.resolve(candidateFilename) === path.resolve(capabilityFilename))
    throw new RelayProtocolError("candidate and capability databases must use separate files");
  const blobDirectory = requiredEnvironment(environment, "FNS_RELAY_BLOB_DIR");
  const capabilityPepper = requiredEnvironment(environment, "FNS_RELAY_CAPABILITY_PEPPER");
  const cursorSecret = requiredEnvironment(environment, "FNS_RELAY_CURSOR_SECRET");
  const source = environment.FNS_RELAY_SOURCE === undefined ? "sqlite:relay-local" : environment.FNS_RELAY_SOURCE;
  const snapshot = environment.FNS_RELAY_SNAPSHOT === undefined ? null : environment.FNS_RELAY_SNAPSHOT;
  const maximumPageSize = optionalPositiveInteger(environment, "FNS_RELAY_MAX_PAGE_SIZE", 1000);
  const defaultPageSize = optionalPositiveInteger(environment, "FNS_RELAY_DEFAULT_PAGE_SIZE", 100);
  const maximumRequestBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_REQUEST_BYTES", 262144);
  const maximumResponseBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_RESPONSE_BYTES", 1048576);
  const maximumUrlBytes = optionalPositiveInteger(environment, "FNS_RELAY_MAX_URL_BYTES", 8192);

  const store = new SQLiteStore({ filename: candidateFilename, source, snapshot });
  let capabilityStore;
  try {
    const candidateStore = new SQLiteCandidateStore({ store });
    const blobStore = new FileSystemBlobStore({ directory: blobDirectory });
    capabilityStore = new SQLiteCapabilityStore({ filename: capabilityFilename, pepper: capabilityPepper, now });
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
      maximumUrlBytes
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

module.exports = { createLocalReferenceRelayApplication };
