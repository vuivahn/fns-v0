"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  FnsStore,
  InvalidRequestError,
  SCHEMA_VERSION,
  SQLiteStore,
  SQLiteStoreAdmin,
  StoreAccessError,
  StoreIntegrityError,
  discoverFromStore
} = require("../src");
const {
  binding,
  bindingA,
  bindingB,
  context,
  fixtureEntries,
  rejects,
  runStoreReadConformance
} = require("./store-conformance");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fns-store-interface-v0-"));
}

function objectIdFor(index) {
  const digest = Buffer.alloc(32);
  digest.writeUInt32BE(index, 28);
  return `fns:obj:sha256:${digest.toString("base64url")}`;
}

function fixtureCoverage() {
  return [
    { method: "bindings", scope: { context, alias: "alice" }, complete: true },
    { method: "releases", scope: { bindingIds: [bindingA] }, complete: true },
    { method: "releases", scope: { bindingIds: [bindingA, bindingB] }, complete: true },
    { method: "communeDocuments", scope: { context }, complete: true }
  ];
}

async function main() {
  const directory = temporaryDirectory();
  let store;
  let recovered;
  let corrupt;
  let largeStore;
  try {
    const filename = path.join(directory, "store.sqlite");
    const backupFilename = path.join(directory, "backup.sqlite");
    store = new SQLiteStore({ filename, source: "sqlite:conformance", snapshot: "fixture-1" });
    assert(store instanceof FnsStore);
    const admin = new SQLiteStoreAdmin(store);
    assert.deepStrictEqual(admin.importSnapshot({ entries: fixtureEntries(), coverage: fixtureCoverage() }), {
      dataRevision: 1,
      objects: 5
    });

    await runStoreReadConformance({
      store,
      source: "sqlite:conformance",
      snapshot: "fixture-1",
      label: "SQLiteStore"
    });
    const discovered = await discoverFromStore({ context, alias: "alice" }, store);
    assert.strictEqual(discovered.bindings.complete, true);
    assert.strictEqual(discovered.releases.complete, true);
    assert.strictEqual(discovered.communeDocuments.complete, true);

    assert.throws(() => admin.appendEntries([{ objectId: bindingA, object: binding("other") }]), StoreIntegrityError);
    admin.setCoverage("releases", { bindingIds: [bindingA, bindingB] }, false);
    assert.strictEqual((await store.findAliasReleases([bindingA, bindingB])).complete, false);
    admin.setCoverage("releases", { bindingIds: [bindingB, bindingA, bindingA] }, true);
    assert.strictEqual((await store.findAliasReleases([bindingA, bindingB])).complete, true);
    assert.deepStrictEqual(admin.appendEntries([{ objectId: objectIdFor(5000), object: { arbitrary: true } }]), {
      dataRevision: 2,
      inserted: 1
    });
    assert.strictEqual((await store.findAliasReleases([bindingA, bindingB])).complete, false);
    assert.deepStrictEqual(admin.verifyIntegrity(), { schemaVersion: SCHEMA_VERSION, dataRevision: 2, objectCount: 6 });

    await admin.backup(backupFilename);
    store.close();
    store = null;
    recovered = new SQLiteStore({ filename: backupFilename, readonly: true });
    assert.strictEqual((await recovered.getObject(bindingA)).object.payload.alias, "alice");
    assert.deepStrictEqual((await recovered.findAliasBindings(context, "alice")).provenance[0], {
      source: "sqlite:conformance",
      snapshot: "fixture-1",
      scope: { context, alias: "alice" },
      complete: false
    });
    assert.throws(
      () => new SQLiteStoreAdmin(recovered).appendEntries([{ objectId: objectIdFor(5001), object: null }]),
      StoreAccessError
    );
    recovered.close();
    recovered = null;

    const direct = new Database(filename);
    direct.prepare("UPDATE fns_store_objects SET object_json = '{}' WHERE object_id = ?").run(bindingA);
    direct.close();
    corrupt = new SQLiteStore({ filename });
    await rejects(StoreIntegrityError, () => corrupt.getObject(bindingA));
    assert.throws(() => new SQLiteStoreAdmin(corrupt).verifyIntegrity(), StoreIntegrityError);
    corrupt.close();
    corrupt = null;

    const futureFilename = path.join(directory, "future.sqlite");
    const future = new Database(futureFilename);
    future.pragma("user_version = 2");
    future.close();
    assert.throws(() => new SQLiteStore({ filename: futureFilename }), StoreIntegrityError);
    assert.throws(() => new SQLiteStore({ filename: "" }), InvalidRequestError);

    largeStore = new SQLiteStore({ filename: ":memory:", source: "sqlite:large-release-batch" });
    const largeAdmin = new SQLiteStoreAdmin(largeStore);
    const bindingIds = Array.from({ length: 1005 }, (_, index) => objectIdFor(index + 1));
    const releaseEntries = bindingIds.map((bindingId, index) => ({
      objectId: objectIdFor(index + 2000),
      object: { payload: { type: "fns.alias.release", binding: bindingId } }
    }));
    largeAdmin.importSnapshot({
      entries: releaseEntries,
      coverage: [{ method: "releases", scope: { bindingIds }, complete: true }]
    });
    const releases = await largeStore.findAliasReleases(bindingIds);
    assert.strictEqual(releases.objects.length, bindingIds.length);
    assert.strictEqual(releases.complete, true);
    largeStore.close();
    largeStore = null;

    const closed = new SQLiteStore({ filename: ":memory:" });
    closed.close();
    await rejects(StoreAccessError, () => closed.getObject(bindingA));

    console.log("SQLiteStore persistence, conformance, migration, coverage, and backup vectors verified");
  } finally {
    for (const candidate of [store, recovered, corrupt, largeStore]) {
      if (candidate) {
        try {
          candidate.close();
        } catch {
          // Temporary test databases are cleaned up below.
        }
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
