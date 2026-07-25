"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { SQLiteStore, SQLiteStoreAdmin, StoreAccessError, StoreIntegrityError } = require("../src");
const relayContract = require("../relay-v1/packages/relay-contract/src");
const { runRelayStorageConformance } = require("../relay-v1/packages/relay-contract/src/conformance");
const {
  RelayAdmissionError,
  RelayAuthenticationError,
  RelayProtocolError
} = require("../relay-v1/packages/relay-contract/src/errors");
const {
  FileSystemBlobStore,
  LocalPublicationPolicy,
  PUBLISH_SCOPE,
  SQLiteCandidateStore
} = require("../relay-v1/packages/relay-local/src");
const { binding, bindingA, bindingB, context, release, releaseObject } = require("./store-conformance");
const {
  createLocalReferenceRelay,
  removeTemporaryRelayDirectory,
  temporaryRelayDirectory
} = require("./relay-support");

test("local Relay uses scoped expiring capabilities and immutable candidate/blob publication", async () => {
  const directory = temporaryRelayDirectory();
  let nowMilliseconds = Date.UTC(2026, 0, 1, 0, 0, 0);
  const now = () => nowMilliseconds;
  const reference = createLocalReferenceRelay(directory, { now });
  try {
    const expiresAt = Math.floor(nowMilliseconds / 1000) + 60;
    const broad = reference.capabilityStore.create({ scopes: [PUBLISH_SCOPE], expiresAt, subject: "publisher-a" });
    const first = await reference.relay.publish(
      { objectId: bindingA, object: binding() },
      {
        authorization: `Bearer ${broad.token}`
      }
    );
    assert.strictEqual(first.publication.inserted, 1);
    assert.strictEqual(first.capabilityId, broad.capability.id);
    const repeated = await reference.relay.publish(
      { objectId: bindingA, object: binding() },
      {
        authorization: `Bearer ${broad.token}`
      }
    );
    assert.strictEqual(repeated.publication.inserted, 0);
    assert.deepStrictEqual(await reference.blobStore.get(bindingA), { objectId: bindingA, object: binding() });
    assert.strictEqual((await reference.relay.findAliasBindings(context, "alice")).complete, false);

    const contextOnly = reference.capabilityStore.create({
      scopes: [`${PUBLISH_SCOPE}:context:${context}`],
      expiresAt
    });
    await reference.relay.publish(
      { objectId: bindingB, object: binding() },
      { authorization: `Bearer ${contextOnly.token}` }
    );
    await assert.rejects(
      () =>
        reference.relay.publish(
          { objectId: release, object: releaseObject },
          { authorization: `Bearer ${contextOnly.token}` }
        ),
      RelayAdmissionError
    );
    await assert.rejects(
      () => reference.relay.publish({ objectId: release, object: releaseObject }),
      RelayAuthenticationError
    );
    await assert.rejects(
      () =>
        reference.relay.publish(
          { objectId: bindingA, object: binding("changed") },
          { authorization: `Bearer ${broad.token}` }
        ),
      StoreIntegrityError
    );

    assert.strictEqual(reference.capabilityStore.revoke(broad.capability.id), true);
    await assert.rejects(
      () =>
        reference.relay.publish(
          { objectId: release, object: releaseObject },
          { authorization: `Bearer ${broad.token}` }
        ),
      RelayAuthenticationError
    );
    nowMilliseconds += 61_000;
    await assert.rejects(
      () =>
        reference.relay.publish(
          { objectId: release, object: releaseObject },
          { authorization: `Bearer ${contextOnly.token}` }
        ),
      RelayAuthenticationError
    );
  } finally {
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("Relay contract package exposes its portable archive surface", () => {
  assert.strictEqual(relayContract.RELAY_ARCHIVE_VERSION, "fns.relay-archive.v1");
  assert.strictEqual(
    relayContract.archiveFileName("2026-01-01T00:00:00.000Z"),
    "fns-relay-2026-01-01T00-00-00-000Z.json"
  );
  assert.throws(() => relayContract.archiveFileName("not-a-date"), RelayProtocolError);
});

test("CC0 Relay archive vector verifies against the portable archive contract", () => {
  const filename = path.join(__dirname, "..", "specs", "relay-v1", "vectors", "minimal-relay-archive-v1.json");
  const archive = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.deepStrictEqual(relayContract.verifyRelayArchive(archive), archive);
});

test("local Relay exports a portable archive and restores only with explicit replace", async () => {
  const sourceDirectory = temporaryRelayDirectory();
  const targetDirectory = temporaryRelayDirectory();
  const now = () => Date.UTC(2026, 0, 1, 0, 0, 0);
  const source = createLocalReferenceRelay(sourceDirectory, { now });
  const target = createLocalReferenceRelay(targetDirectory, { now });
  try {
    const publication = source.capabilityStore.create({
      scopes: [PUBLISH_SCOPE],
      expiresAt: Math.floor(now() / 1000) + 600
    });
    await source.relay.publish(
      { objectId: bindingA, object: binding() },
      { authorization: `Bearer ${publication.token}` }
    );
    const archive = await source.relay.exportArchive({ exportedAt: "2026-01-01T00:00:00.000Z" });
    assert.strictEqual(archive.version, "fns.relay-archive.v1");
    assert.strictEqual(JSON.stringify(archive).includes(publication.token), false);
    assert.deepStrictEqual(await target.relay.restoreArchive(archive), {
      mode: "validate",
      entries: 1,
      coverage: 0,
      blobs: 1
    });
    assert.strictEqual(await target.relay.getObject(bindingA), null);
    await target.relay.restoreArchive(archive, { mode: "replace" });
    assert.deepStrictEqual(await target.relay.getObject(bindingA), { objectId: bindingA, object: binding() });
    assert.strictEqual((await target.relay.verifyIntegrity()).blobs.blobs, 1);

    const tampered = { ...archive, digest: "invalid" };
    await assert.rejects(() => target.relay.restoreArchive(tampered), RelayProtocolError);
    await assert.rejects(
      () => target.relay.restoreArchive({ ...archive, unexpected: "not portable" }),
      RelayProtocolError
    );
    await assert.rejects(
      () => target.relay.restoreArchive({ ...archive, exportedAt: "2026-13-01T00:00:00.000Z" }),
      RelayProtocolError
    );
  } finally {
    source.close();
    target.close();
    removeTemporaryRelayDirectory(sourceDirectory);
    removeTemporaryRelayDirectory(targetDirectory);
  }
});

test("SQLite candidate and filesystem blob adapters pass the reusable storage contract", async () => {
  const directory = temporaryRelayDirectory();
  const reference = createLocalReferenceRelay(directory);
  try {
    const result = await runRelayStorageConformance({
      candidateStore: reference.candidateStore,
      blobStore: reference.blobStore,
      fixture: { objectId: context, object: { payload: { type: "fns.commune.genesis" } } }
    });
    assert.strictEqual(result.candidateSnapshot.entries.length, 1);
    assert.strictEqual(result.blobs.length, 1);
  } finally {
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("SQLite Relay page queries fetch only the requested page plus its cursor witness", async () => {
  const directory = temporaryRelayDirectory();
  const reference = createLocalReferenceRelay(directory);
  try {
    await reference.candidateStore.publishImmutable([
      { objectId: bindingA, object: binding() },
      { objectId: bindingB, object: binding() }
    ]);
    const first = await reference.candidateStore.findAliasBindingsPage(context, "alice", {
      afterObjectId: null,
      limit: 1
    });
    assert.strictEqual(first.objects.length, 1);
    assert.strictEqual(first.hasMore, true);
    const second = await reference.candidateStore.findAliasBindingsPage(context, "alice", {
      afterObjectId: first.objects[0].objectId,
      limit: 1
    });
    assert.strictEqual(second.objects.length, 1);
    assert.strictEqual(second.hasMore, false);
  } finally {
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("filesystem blob adapter supports a read-only archive/export profile", async () => {
  const directory = temporaryRelayDirectory();
  const reference = createLocalReferenceRelay(directory);
  let readonly;
  try {
    await reference.blobStore.putIfAbsent({ objectId: bindingA, object: binding() });
    readonly = new FileSystemBlobStore({ directory: `${directory}/blobs`, readonly: true });
    assert.deepStrictEqual(await readonly.get(bindingA), { objectId: bindingA, object: binding() });
    assert.deepStrictEqual(await readonly.exportBlobs([bindingA]), [{ objectId: bindingA, object: binding() }]);
    assert.deepStrictEqual(await readonly.readiness(), { directory: "ok" });
    await assert.rejects(() => readonly.putIfAbsent({ objectId: bindingB, object: binding() }), StoreAccessError);
  } finally {
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("local Relay adapters reject split management and non-boolean local policy decisions", async () => {
  const directory = temporaryRelayDirectory();
  const reference = createLocalReferenceRelay(directory);
  const otherStore = new SQLiteStore({ filename: `${directory}/other.sqlite` });
  try {
    assert.throws(
      () => new SQLiteCandidateStore({ store: reference.store, admin: new SQLiteStoreAdmin(otherStore) }),
      /supplied SQLiteStore/
    );
    for (const decision of [false, { allowed: true }]) {
      const policy = new LocalPublicationPolicy({ evaluate: async () => decision });
      await assert.rejects(
        () =>
          policy.admit({
            capability: { id: "local", scopes: [PUBLISH_SCOPE] },
            candidates: [{ objectId: bindingA, object: binding() }]
          }),
        RelayAdmissionError
      );
    }
  } finally {
    otherStore.close();
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});
