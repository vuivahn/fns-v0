"use strict";

const assert = require("assert");
const { assertRelayBlobStore, assertRelayCandidateStore, normalizeCandidate } = require("./validation");

async function runRelayStorageConformance({ candidateStore, blobStore, fixture }) {
  assertRelayCandidateStore(candidateStore);
  assertRelayBlobStore(blobStore);
  const candidate = normalizeCandidate(fixture);
  const firstBlob = await blobStore.putIfAbsent(candidate);
  assert.deepStrictEqual(firstBlob, candidate);
  assert.deepStrictEqual(await blobStore.get(candidate.objectId), candidate);

  const firstPublication = await candidateStore.publishImmutable([candidate]);
  assert.strictEqual(firstPublication.inserted, 1);
  const repeatedPublication = await candidateStore.publishImmutable([candidate]);
  assert.strictEqual(repeatedPublication.inserted, 0);
  assert.deepStrictEqual(await candidateStore.getObject(candidate.objectId), candidate);
  await assert.rejects(() =>
    blobStore.putIfAbsent({ objectId: candidate.objectId, object: { relayConformanceConflict: true } })
  );
  await assert.rejects(() =>
    candidateStore.publishImmutable([{ objectId: candidate.objectId, object: { relayConformanceConflict: true } }])
  );

  const page = await candidateStore.findCommuneDocumentsPage(candidate.objectId, { afterObjectId: null, limit: 1 });
  assert.strictEqual(page.objects.length, 1);
  assert.strictEqual(page.hasMore, false);

  const candidateSnapshot = await candidateStore.exportSnapshot();
  const blobs = await blobStore.exportBlobs(candidateSnapshot.entries.map((entry) => entry.objectId));
  assert.strictEqual(blobs.length, candidateSnapshot.entries.length);
  return { candidateSnapshot, blobs };
}

module.exports = { runRelayStorageConformance };
