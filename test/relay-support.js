"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SQLiteStore } = require("../src");
const {
  FileSystemBlobStore,
  LocalPublicationPolicy,
  LocalReferenceRelay,
  SQLiteCandidateStore,
  SQLiteCapabilityStore
} = require("../relay-v1/packages/relay-local/src");

function temporaryRelayDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fns-relay-v1-"));
}

function createLocalReferenceRelay(directory, { now = () => Date.now() } = {}) {
  const store = new SQLiteStore({
    filename: path.join(directory, "candidates.sqlite"),
    source: "sqlite:relay-reference",
    snapshot: "reference-fixture"
  });
  const candidateStore = new SQLiteCandidateStore({ store });
  const blobStore = new FileSystemBlobStore({ directory: path.join(directory, "blobs") });
  const capabilityStore = new SQLiteCapabilityStore({
    filename: path.join(directory, "capabilities.sqlite"),
    pepper: "local-reference-capability-pepper-32-bytes-minimum",
    now
  });
  const publicationPolicy = new LocalPublicationPolicy();
  const relay = new LocalReferenceRelay({
    candidateStore,
    blobStore,
    capabilityVerifier: capabilityStore,
    publicationPolicy
  });
  return {
    relay,
    store,
    candidateStore,
    blobStore,
    capabilityStore,
    close() {
      capabilityStore.close();
      store.close();
    }
  };
}

function removeTemporaryRelayDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

module.exports = { createLocalReferenceRelay, removeTemporaryRelayDirectory, temporaryRelayDirectory };
