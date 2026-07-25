"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { FnsStore, InvalidRequestError } = require("../src");

const vector = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "test-vectors", "store-interface-v0.json"), "utf8")
);
assert.deepStrictEqual(vector.cases.slice().sort(), [
  "adapter-contract-validation",
  "async-adapter",
  "canonical-object-id",
  "codepoint-order",
  "conflicting-object-id",
  "defensive-copy",
  "equivalent-duplicate",
  "falsy-candidate-conflict",
  "independent-completeness",
  "invalid-request",
  "json-value-boundary",
  "malformed-addressable",
  "parallel-failure-observation",
  "provenance-and-warnings",
  "unindexed-malformed"
]);

const { context, bindingA, bindingB, release, unindexed } = vector.objectIds;
const binding = (alias = "alice") => ({ payload: { type: "fns.alias.bind", context, alias } });
const releaseObject = { payload: { type: "fns.alias.release", binding: bindingA } };

function fixtureEntries() {
  return [
    { objectId: bindingB, object: binding("alice") },
    { objectId: bindingA, object: binding("alice") },
    { objectId: bindingA, object: binding("alice") },
    { objectId: release, object: releaseObject },
    { objectId: context, object: { payload: { type: "fns.commune.genesis" } } },
    { objectId: unindexed, object: { arbitrary: ["malformed"] } }
  ];
}

async function rejects(Type, action) {
  await assert.rejects(action, (error) => error instanceof Type);
}

async function runStoreReadConformance({ store, source, snapshot, label = "store" }) {
  assert(store instanceof FnsStore, `${label} must extend FnsStore`);
  const bindingsPromise = store.findAliasBindings(context, "alice");
  assert(bindingsPromise instanceof Promise, `${label} discovery methods must return a Promise`);
  const bindings = await bindingsPromise;
  assert.deepStrictEqual(
    bindings.objects.map((entry) => entry.objectId),
    [bindingA, bindingB]
  );
  assert.strictEqual(bindings.complete, true);
  assert.deepStrictEqual(bindings.provenance[0], {
    source,
    snapshot,
    scope: { context, alias: "alice" },
    complete: true
  });

  const releases = await store.findAliasReleases([bindingA, bindingA]);
  assert.deepStrictEqual(
    releases.objects.map((entry) => entry.objectId),
    [release]
  );
  assert.deepStrictEqual(releases.provenance[0].scope.bindingIds, [bindingA]);
  assert.strictEqual((await store.findAliasBindings(context, "missing")).objects.length, 0);
  assert.strictEqual(await store.getObject("fns:obj:sha256:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA"), null);
  assert.deepStrictEqual(
    (await store.findCommuneDocuments(context)).objects.map((entry) => entry.objectId),
    [context]
  );
  assert.strictEqual(
    (await store.findAliasBindings(context, "alice")).objects.some((entry) => entry.objectId === unindexed),
    false
  );

  const fetched = await store.getObject(bindingA);
  fetched.object.payload.alias = "changed";
  assert.strictEqual((await store.getObject(bindingA)).object.payload.alias, "alice");

  await rejects(InvalidRequestError, () => store.findAliasBindings("not-an-id", "alice"));
  await rejects(InvalidRequestError, () => store.findAliasReleases("not-an-array"));
  const nonCanonicalObjectId = `fns:obj:sha256:${"A".repeat(42)}B`;
  await rejects(InvalidRequestError, () => store.getObject(nonCanonicalObjectId));
}

module.exports = {
  binding,
  bindingA,
  bindingB,
  context,
  fixtureEntries,
  rejects,
  release,
  releaseObject,
  runStoreReadConformance,
  unindexed,
  vector
};
