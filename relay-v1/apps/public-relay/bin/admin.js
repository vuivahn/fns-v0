"use strict";

process.umask(0o077);

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SQLiteStore } = require("../../../../src");
const { createRelayArchive, verifyRelayArchive } = require("../../../packages/relay-contract/src/archive");
const {
  FileSystemBlobStore,
  SQLiteCandidateStore,
  SQLiteCapabilityStore
} = require("../../../packages/relay-local/src");
const { readRequiredSecret } = require("../src/local-reference-app");

const DATA_COMMANDS = new Set(["export", "verify", "restore-validate", "restore-replace"]);
const ARCHIVE_ONLY_COMMANDS = new Set(["verify-archive"]);

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  npm run admin -- export <archive.json>",
      "  npm run admin -- verify",
      "  npm run admin -- verify-archive <archive.json>",
      "  npm run admin -- restore-validate <archive.json>",
      "  npm run admin -- restore-replace <archive.json> --confirm-replace",
      "  npm run admin -- issue-capability <expires-at-unix-seconds> <scope> [scope...]",
      "  npm run admin -- revoke-capability <capability-id>"
    ].join("\n") + "\n"
  );
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be set`);
  return value;
}

function readArchive(filename) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("archive filename is required");
  return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeArchive(filename, archive) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("archive filename is required");
  const destination = path.resolve(filename);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${crypto.randomBytes(12).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(archive)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, destination);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A private temporary archive is not a successful backup and can be cleaned up later.
    }
  }
  return destination;
}

function createDataAdmin(environment, { readonly = false } = {}) {
  const candidateFilename = requiredEnvironment(environment, "FNS_RELAY_CANDIDATES_DB");
  const blobDirectory = requiredEnvironment(environment, "FNS_RELAY_BLOB_DIR");
  const source = environment.FNS_RELAY_SOURCE === undefined ? "sqlite:relay-local" : environment.FNS_RELAY_SOURCE;
  const snapshot = environment.FNS_RELAY_SNAPSHOT === undefined ? null : environment.FNS_RELAY_SNAPSHOT;
  const store = new SQLiteStore({ filename: candidateFilename, source, snapshot, readonly });
  try {
    const candidateStore = new SQLiteCandidateStore({ store });
    const blobStore = new FileSystemBlobStore({ directory: blobDirectory, readonly });
    let closed = false;
    return {
      async exportArchive({ exportedAt }) {
        const candidateSnapshot = await candidateStore.exportSnapshot();
        const blobs = await blobStore.exportBlobs(candidateSnapshot.entries.map((entry) => entry.objectId));
        return createRelayArchive({ candidateSnapshot, blobs, exportedAt });
      },
      async restoreArchive(archive, { mode }) {
        const normalized = verifyRelayArchive(archive);
        if (mode === "validate")
          return {
            mode,
            entries: normalized.candidateSnapshot.entries.length,
            coverage: normalized.candidateSnapshot.coverage.length,
            blobs: normalized.blobs.length
          };
        if (mode !== "replace") throw new Error("restore mode must be validate or replace");
        await blobStore.restoreBlobs(normalized.blobs);
        const candidateResult = await candidateStore.restoreSnapshot(normalized.candidateSnapshot, { mode });
        return { mode, candidateResult, blobs: normalized.blobs.length };
      },
      async verifyIntegrity() {
        const candidate = await candidateStore.verifyIntegrity();
        const blobs = await blobStore.verifyIntegrity();
        const archive = await this.exportArchive({ exportedAt: new Date(0).toISOString() });
        return { candidate, blobs, archiveDigest: archive.digest };
      },
      close() {
        if (closed) return;
        closed = true;
        store.close();
      }
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

function createCapabilityAdmin(environment) {
  return new SQLiteCapabilityStore({
    filename: requiredEnvironment(environment, "FNS_RELAY_CAPABILITY_DB"),
    pepper: readRequiredSecret(environment, "FNS_RELAY_CAPABILITY_PEPPER")
  });
}

function parseExpiry(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error("capability expiry must be a future Unix timestamp in seconds");
  const expiresAt = Number(value);
  if (!Number.isSafeInteger(expiresAt)) throw new Error("capability expiry is outside the supported range");
  return expiresAt;
}

async function run(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...arguments_] = argv;
  if (ARCHIVE_ONLY_COMMANDS.has(command)) {
    const [filename] = arguments_;
    if (arguments_.length !== 1) {
      usage();
      throw new Error("verify-archive has invalid arguments");
    }
    const archive = verifyRelayArchive(readArchive(filename));
    process.stdout.write(
      `${JSON.stringify({
        command,
        result: {
          version: archive.version,
          exportedAt: archive.exportedAt,
          entries: archive.candidateSnapshot.entries.length,
          coverage: archive.candidateSnapshot.coverage.length,
          blobs: archive.blobs.length,
          digest: archive.digest
        }
      })}\n`
    );
    return;
  }
  if (DATA_COMMANDS.has(command)) {
    const [filename, confirmation] = arguments_;
    if (command === "restore-replace" && confirmation !== "--confirm-replace") {
      usage();
      throw new Error("restore-replace requires --confirm-replace");
    }
    if (
      ["export", "restore-validate", "restore-replace"].includes(command) &&
      arguments_.length !== (command === "restore-replace" ? 2 : 1)
    ) {
      usage();
      throw new Error(`${command} has invalid arguments`);
    }
    if (command === "verify" && arguments_.length !== 0) {
      usage();
      throw new Error("verify has no arguments");
    }
    const admin = createDataAdmin(environment, { readonly: command !== "restore-replace" });
    try {
      if (command === "export") {
        const archive = await admin.exportArchive({ exportedAt: new Date().toISOString() });
        const destination = writeArchive(filename, archive);
        process.stdout.write(`${JSON.stringify({ command, destination, digest: archive.digest })}\n`);
        return;
      }
      if (command === "verify") {
        process.stdout.write(`${JSON.stringify({ command, report: await admin.verifyIntegrity() })}\n`);
        return;
      }
      const mode = command === "restore-replace" ? "replace" : "validate";
      process.stdout.write(
        `${JSON.stringify({ command, result: await admin.restoreArchive(readArchive(filename), { mode }) })}\n`
      );
    } finally {
      admin.close();
    }
    return;
  }

  if (command === "issue-capability") {
    const [expiry, ...scopes] = arguments_;
    if (scopes.length === 0) {
      usage();
      throw new Error("issue-capability requires at least one scope");
    }
    const capabilities = createCapabilityAdmin(environment);
    try {
      const issued = capabilities.create({ scopes, expiresAt: parseExpiry(expiry) });
      // This is the only supported path that writes a raw bearer capability to stdout.
      process.stdout.write(`${JSON.stringify({ command, token: issued.token, capability: issued.capability })}\n`);
    } finally {
      capabilities.close();
    }
    return;
  }

  if (command === "revoke-capability") {
    const [tokenId] = arguments_;
    if (arguments_.length !== 1) {
      usage();
      throw new Error("revoke-capability requires one capability id");
    }
    const capabilities = createCapabilityAdmin(environment);
    try {
      process.stdout.write(`${JSON.stringify({ command, tokenId, revoked: capabilities.revoke(tokenId) })}\n`);
    } finally {
      capabilities.close();
    }
    return;
  }

  usage();
  throw new Error("a supported admin command is required");
}

run().catch((error) => {
  process.stderr.write(`Relay admin command failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { createCapabilityAdmin, createDataAdmin, run, writeArchive };
