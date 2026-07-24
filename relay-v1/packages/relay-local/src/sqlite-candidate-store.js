"use strict";

const { InvalidRequestError, SQLiteStore, SQLiteStoreAdmin } = require("../../../../src");
const { RelayProtocolError } = require("../../relay-contract/src/errors");
const { normalizeCandidates, normalizeStoreExport } = require("../../relay-contract/src/validation");

class SQLiteCandidateStore {
  constructor({ store, admin = null }) {
    if (!(store instanceof SQLiteStore))
      throw new InvalidRequestError("SQLiteCandidateStore requires a SQLiteStore instance");
    if (admin !== null && (!(admin instanceof SQLiteStoreAdmin) || admin.store !== store))
      throw new InvalidRequestError("admin must manage the supplied SQLiteStore instance or be null");
    this.store = store;
    this.admin = admin ?? new SQLiteStoreAdmin(store);
  }

  async getObject(objectId) {
    return this.store.getObject(objectId);
  }

  async findAliasBindings(context, alias) {
    return this.store.findAliasBindings(context, alias);
  }

  async findAliasReleases(bindingIds) {
    return this.store.findAliasReleases(bindingIds);
  }

  async findCommuneDocuments(context) {
    return this.store.findCommuneDocuments(context);
  }

  async findAliasBindingsPage(context, alias, page) {
    return this.admin.findAliasBindingsPage(context, alias, page);
  }

  async findAliasReleasesPage(bindingIds, page) {
    return this.admin.findAliasReleasesPage(bindingIds, page);
  }

  async findCommuneDocumentsPage(context, page) {
    return this.admin.findCommuneDocumentsPage(context, page);
  }

  async publishImmutable(candidates) {
    const entries = normalizeCandidates(candidates);
    const result = this.admin.appendEntries(entries);
    return { inserted: result.inserted, dataRevision: result.dataRevision };
  }

  async exportSnapshot() {
    return normalizeStoreExport(this.admin.exportSnapshot());
  }

  async restoreSnapshot(snapshot, { mode = "validate" } = {}) {
    const normalized = normalizeStoreExport(snapshot);
    if (mode === "validate") return { mode, entries: normalized.entries.length, coverage: normalized.coverage.length };
    if (mode !== "replace") throw new RelayProtocolError("restore mode must be validate or replace", { mode });
    const result = this.admin.importSnapshot({
      entries: normalized.entries,
      coverage: normalized.coverage,
      source: normalized.source,
      snapshot: normalized.snapshot,
      replace: true
    });
    return { mode, ...result };
  }

  async readiness() {
    await this.store.getObject("fns:obj:sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    return { database: "ok" };
  }

  async verifyIntegrity() {
    return this.admin.verifyIntegrity();
  }
}

module.exports = { SQLiteCandidateStore };
