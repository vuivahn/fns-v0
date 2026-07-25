"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const { resolveAlias } = require("fns-v0-validator");
const {
  FnsStore,
  MemoryStore,
  InvalidRequestError,
  StoreAccessError,
  StoreIntegrityError,
  discoverFromStore,
  resolveAliasFromStore
} = require("../src");
const {
  binding,
  bindingA,
  context,
  fixtureEntries,
  release,
  releaseObject,
  runStoreReadConformance,
  unindexed
} = require("./store-conformance");
const envelope = (objects = [], overrides = {}) => ({
  version: "fns.store-discovery.v0",
  objects,
  complete: true,
  provenance: [],
  warnings: [],
  ...overrides
});

async function rejects(Type, action) {
  await assert.rejects(action, (error) => error instanceof Type);
}

(async () => {
  const store = new MemoryStore({ source: "memory:conformance", snapshot: "fixture-1" });
  assert(store instanceof FnsStore);
  for (const entry of fixtureEntries()) store.put(entry);
  await runStoreReadConformance({
    store,
    source: "memory:conformance",
    snapshot: "fixture-1",
    label: "MemoryStore"
  });

  assert.throws(() => store.put({ objectId: bindingA, object: binding("other") }), StoreIntegrityError);
  await rejects(InvalidRequestError, () => store.findAliasBindings("not-an-id", "alice"));
  await rejects(InvalidRequestError, () => store.findAliasReleases("not-an-array"));
  const nonCanonicalObjectId = `fns:obj:sha256:${"A".repeat(42)}B`;
  assert.throws(() => store.put({ objectId: nonCanonicalObjectId, object: null }), InvalidRequestError);
  await rejects(InvalidRequestError, () => store.getObject(nonCanonicalObjectId));
  assert.throws(() => store.put({ objectId: unindexed, object: NaN }), InvalidRequestError);
  assert.throws(() => store.put({ objectId: unindexed, object: { ignored: undefined } }), InvalidRequestError);
  assert.throws(() => store.put({ objectId: unindexed, object: new Date() }), InvalidRequestError);
  assert.throws(() => new MemoryStore({ source: 1 }), InvalidRequestError);
  assert.throws(() => new MemoryStore({ completeness: { bindings: "yes" } }), InvalidRequestError);
  assert.strictEqual(new StoreAccessError("offline").code, "E_STORE_ACCESS");

  const sortableObjectId = (marker) => `fns:obj:sha256:${"A".repeat(41)}${marker}A`;
  const hyphenObjectId = sortableObjectId("-");
  const underscoreObjectId = sortableObjectId("_");
  const ordered = new MemoryStore({
    entries: [
      { objectId: underscoreObjectId, object: binding() },
      { objectId: hyphenObjectId, object: binding() }
    ]
  });
  assert.deepStrictEqual(
    (await ordered.findAliasBindings(context, "alice")).objects.map((entry) => entry.objectId),
    [hyphenObjectId, underscoreObjectId]
  );

  const incomplete = new MemoryStore({
    source: "memory:partial",
    completeness: { bindings: false, releases: false, communeDocuments: true },
    entries: [
      { objectId: bindingA, object: binding() },
      { objectId: release, object: releaseObject },
      { objectId: context, object: { payload: { type: "fns.commune.genesis" } } }
    ]
  });
  const discovery = await discoverFromStore({ context, alias: "alice" }, incomplete);
  assert.strictEqual(discovery.bindings.complete, false);
  assert.strictEqual(discovery.releases.complete, false);
  assert.strictEqual(discovery.communeDocuments.complete, true);
  assert.deepStrictEqual(
    discovery.warnings.map((warning) => warning.code),
    ["W_STORE_DISCOVERY_INCOMPLETE", "W_STORE_DISCOVERY_INCOMPLETE", "W_STORE_DISCOVERY_INCOMPLETE"]
  );

  const resolved = await resolveAliasFromStore({ context, alias: "alice" }, incomplete);
  assert.deepStrictEqual(
    resolved.resolution,
    resolveAlias({ context, alias: "alice" }, discovery.objectStore, { discovery: { complete: false } })
  );
  assert.strictEqual(resolved.resolution.discovery.complete, false);
  assert.strictEqual(resolved.storeDiscovery.releases.complete, false);
  assert(resolved.warnings.some((warning) => warning.detail?.methods?.includes("releases")));
  assert.strictEqual(resolved.resolution.claims.length, 1);

  const permissiveStore = {
    async findAliasBindings() {
      return envelope();
    },
    async findAliasReleases() {
      return envelope();
    },
    async findCommuneDocuments() {
      return envelope();
    }
  };
  await rejects(InvalidRequestError, () =>
    discoverFromStore({ context: "not-an-object-id", alias: "alice" }, permissiveStore)
  );
  await rejects(InvalidRequestError, () => discoverFromStore({ context, alias: 7 }, permissiveStore));
  await rejects(InvalidRequestError, () => discoverFromStore({ context, alias: "alice" }, {}));
  let optionValidationCalls = 0;
  const optionValidationStore = {
    async findAliasBindings() {
      optionValidationCalls += 1;
      return envelope();
    },
    async findAliasReleases() {
      optionValidationCalls += 1;
      return envelope();
    },
    async findCommuneDocuments() {
      optionValidationCalls += 1;
      return envelope();
    }
  };
  await rejects(InvalidRequestError, () =>
    resolveAliasFromStore({ context, alias: "alice" }, optionValidationStore, null)
  );
  assert.strictEqual(optionValidationCalls, 0);

  const malformedStore = {
    async findAliasBindings() {
      return { version: "wrong", objects: [], complete: "yes", provenance: "not-an-array", warnings: [] };
    },
    async findAliasReleases() {
      return envelope();
    },
    async findCommuneDocuments() {
      return envelope();
    }
  };
  await rejects(StoreIntegrityError, () => discoverFromStore({ context, alias: "alice" }, malformedStore));

  const malformedCandidateStore = {
    async findAliasBindings() {
      return envelope([{ objectId: "not-an-object-id", object: null }]);
    },
    async findAliasReleases() {
      return envelope();
    },
    async findCommuneDocuments() {
      return envelope();
    }
  };
  await rejects(StoreIntegrityError, () => discoverFromStore({ context, alias: "alice" }, malformedCandidateStore));

  const malformedDiagnosticStore = {
    async findAliasBindings() {
      return envelope([], { warnings: [{ code: 7 }] });
    },
    async findAliasReleases() {
      return envelope();
    },
    async findCommuneDocuments() {
      return envelope();
    }
  };
  await rejects(StoreIntegrityError, () => discoverFromStore({ context, alias: "alice" }, malformedDiagnosticStore));

  const conflictingFalsyCandidateStore = {
    async findAliasBindings() {
      return envelope([{ objectId: bindingA, object: null }]);
    },
    async findAliasReleases() {
      return envelope([{ objectId: bindingA, object: { changed: true } }]);
    },
    async findCommuneDocuments() {
      return envelope();
    }
  };
  await rejects(StoreIntegrityError, () =>
    discoverFromStore({ context, alias: "alice" }, conflictingFalsyCandidateStore)
  );

  const childScript = `
    const { discoverFromStore, StoreAccessError } = require("./src");
    const store = {
      async findAliasBindings() { throw new StoreAccessError("bindings unavailable"); },
      async findAliasReleases() { throw new StoreAccessError("releases unavailable"); },
      async findCommuneDocuments() { throw new StoreAccessError("commune unavailable"); }
    };
    (async () => {
      try {
        await discoverFromStore({ context: ${JSON.stringify(context)}, alias: "alice" }, store);
        process.exitCode = 1;
      } catch (error) {
        if (!(error instanceof StoreAccessError)) {
          console.error(error);
          process.exitCode = 1;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", childScript], { cwd: process.cwd(), encoding: "utf8" });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);

  console.log("Store Interface v0 MemoryStore, adapter, and negative vectors verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
