"use strict";

const crypto = require("crypto");
const { cloneJson, compareText, stableJson } = require("../../../../src/store-utils");
const { RelayProtocolError } = require("./errors");
const { normalizeCandidates, normalizeStoreExport } = require("./validation");

const RELAY_ARCHIVE_VERSION = "fns.relay-archive.v1";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARCHIVE_KEYS = new Set(["version", "exportedAt", "candidateSnapshot", "blobs", "digest"]);

function digest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("base64url");
}

function normalizeBlobs(blobs, candidates) {
  const expected = new Map(candidates.map((candidate) => [candidate.objectId, candidate]));
  const normalized = normalizeCandidates(blobs);
  if (normalized.length !== candidates.length)
    throw new RelayProtocolError("archive blobs do not match the candidate snapshot");
  for (const blob of normalized) {
    const candidate = expected.get(blob.objectId);
    if (!candidate || stableJson(candidate.object) !== stableJson(blob.object))
      throw new RelayProtocolError("archive blob does not match the candidate snapshot", { objectId: blob.objectId });
  }
  return normalized;
}

function normalizeExportedAt(exportedAt) {
  if (typeof exportedAt !== "string" || !ISO_TIMESTAMP.test(exportedAt))
    throw new RelayProtocolError("exportedAt must be an ISO timestamp with milliseconds in UTC", { exportedAt });
  let normalized;
  try {
    normalized = new Date(exportedAt).toISOString();
  } catch {
    throw new RelayProtocolError("exportedAt must be a valid ISO timestamp", { exportedAt });
  }
  if (normalized !== exportedAt)
    throw new RelayProtocolError("exportedAt must be a valid ISO timestamp", { exportedAt });
  return exportedAt;
}

function createRelayArchive({ candidateSnapshot, blobs, exportedAt }) {
  const normalizedSnapshot = normalizeStoreExport(candidateSnapshot);
  const normalizedBlobs = normalizeBlobs(blobs, normalizedSnapshot.entries);
  const normalizedExportedAt = normalizeExportedAt(exportedAt);
  const unsigned = {
    version: RELAY_ARCHIVE_VERSION,
    exportedAt: normalizedExportedAt,
    candidateSnapshot: normalizedSnapshot,
    blobs: normalizedBlobs
  };
  return { ...unsigned, digest: digest(unsigned) };
}

function verifyRelayArchive(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RelayProtocolError("relay archive must be an object");
  if (Object.keys(value).some((key) => !ARCHIVE_KEYS.has(key)))
    throw new RelayProtocolError("relay archive contains unsupported fields");
  const { version, exportedAt, candidateSnapshot, blobs, digest: suppliedDigest } = value;
  if (version !== RELAY_ARCHIVE_VERSION)
    throw new RelayProtocolError("relay archive version is not supported", { version });
  const normalized = createRelayArchive({ candidateSnapshot, blobs, exportedAt });
  if (typeof suppliedDigest !== "string" || suppliedDigest !== normalized.digest)
    throw new RelayProtocolError("relay archive digest does not match its content");
  return cloneJson(normalized);
}

function archiveFileName(exportedAt) {
  return `fns-relay-${normalizeExportedAt(exportedAt).replace(/[:.]/g, "-")}.json`;
}

function compareArchiveEntries(left, right) {
  return compareText(left.objectId, right.objectId);
}

module.exports = {
  RELAY_ARCHIVE_VERSION,
  archiveFileName,
  compareArchiveEntries,
  createRelayArchive,
  digest,
  normalizeExportedAt,
  verifyRelayArchive
};
