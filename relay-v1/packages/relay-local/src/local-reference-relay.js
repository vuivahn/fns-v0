"use strict";

const { RelayProtocolError } = require("../../relay-contract/src/errors");
const {
  assertRelayBlobStore,
  assertRelayCandidateStore,
  normalizeCandidate
} = require("../../relay-contract/src/validation");
const { createRelayArchive, verifyRelayArchive } = require("../../relay-contract/src/archive");

class LocalReferenceRelay {
  constructor({ candidateStore, blobStore, capabilityVerifier, publicationPolicy }) {
    assertRelayCandidateStore(candidateStore);
    assertRelayBlobStore(blobStore);
    if (!capabilityVerifier || typeof capabilityVerifier.verifyBearer !== "function")
      throw new RelayProtocolError("capabilityVerifier must implement verifyBearer");
    if (!publicationPolicy || typeof publicationPolicy.admit !== "function")
      throw new RelayProtocolError("publicationPolicy must implement admit");
    this.candidateStore = candidateStore;
    this.blobStore = blobStore;
    this.capabilityVerifier = capabilityVerifier;
    this.publicationPolicy = publicationPolicy;
  }

  async getObject(objectId) {
    return this.candidateStore.getObject(objectId);
  }

  async findAliasBindings(context, alias) {
    return this.candidateStore.findAliasBindings(context, alias);
  }

  async findAliasReleases(bindingIds) {
    return this.candidateStore.findAliasReleases(bindingIds);
  }

  async findCommuneDocuments(context) {
    return this.candidateStore.findCommuneDocuments(context);
  }

  async findAliasBindingsPage(context, alias, page) {
    return this.candidateStore.findAliasBindingsPage(context, alias, page);
  }

  async findAliasReleasesPage(bindingIds, page) {
    return this.candidateStore.findAliasReleasesPage(bindingIds, page);
  }

  async findCommuneDocumentsPage(context, page) {
    return this.candidateStore.findCommuneDocumentsPage(context, page);
  }

  async publish(value, { authorization, request = null } = {}) {
    const candidate = normalizeCandidate(value);
    const capability = await this.capabilityVerifier.verifyBearer(authorization);
    const admitted = await this.publicationPolicy.admit({ capability, candidates: [candidate], request });
    await this.blobStore.putIfAbsent(candidate);
    const publication = await this.candidateStore.publishImmutable([candidate]);
    return { candidate, publication, capabilityId: admitted.capabilityId };
  }

  async exportArchive({ exportedAt }) {
    const candidateSnapshot = await this.candidateStore.exportSnapshot();
    const blobs = await this.blobStore.exportBlobs(candidateSnapshot.entries.map((entry) => entry.objectId));
    return createRelayArchive({ candidateSnapshot, blobs, exportedAt });
  }

  async restoreArchive(archive, { mode = "validate" } = {}) {
    const normalized = verifyRelayArchive(archive);
    if (mode === "validate")
      return {
        mode,
        entries: normalized.candidateSnapshot.entries.length,
        coverage: normalized.candidateSnapshot.coverage.length,
        blobs: normalized.blobs.length
      };
    if (mode !== "replace") throw new RelayProtocolError("restore mode must be validate or replace", { mode });
    await this.blobStore.restoreBlobs(normalized.blobs);
    const candidateResult = await this.candidateStore.restoreSnapshot(normalized.candidateSnapshot, { mode });
    return { mode, candidateResult, blobs: normalized.blobs.length };
  }

  async readiness() {
    const candidate = await this.candidateStore.readiness();
    const blobs = await this.blobStore.readiness();
    const capabilities =
      typeof this.capabilityVerifier.readiness === "function"
        ? await this.capabilityVerifier.readiness()
        : { capabilityVerifier: "not-checked" };
    return { candidate, blobs, capabilities };
  }

  async verifyIntegrity() {
    const candidate = await this.candidateStore.verifyIntegrity();
    const blobs = await this.blobStore.verifyIntegrity();
    const archive = await this.exportArchive({ exportedAt: new Date(0).toISOString() });
    return { candidate, blobs, archiveDigest: archive.digest };
  }
}

module.exports = { LocalReferenceRelay };
