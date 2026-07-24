"use strict";

const fs = require("fs");
const path = require("path");
const { createLocalReferenceRelayApplication } = require("../src/local-reference-app");

function usage() {
  process.stderr.write(
    "Usage: npm run admin -- <export|verify|restore-validate|restore-replace> [archive.json] [--confirm-replace]\n"
  );
}

function readArchive(filename) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("archive filename is required");
  return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
}

function writeArchive(filename, archive) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("archive filename is required");
  const destination = path.resolve(filename);
  let descriptor;
  try {
    descriptor = fs.openSync(destination, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(archive)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return destination;
}

async function run(argv = process.argv.slice(2)) {
  const [command, filename, confirmation] = argv;
  if (!["export", "verify", "restore-validate", "restore-replace"].includes(command)) {
    usage();
    throw new Error("a supported admin command is required");
  }
  if (command === "restore-replace" && confirmation !== "--confirm-replace") {
    usage();
    throw new Error("restore-replace requires --confirm-replace");
  }

  const application = createLocalReferenceRelayApplication();
  try {
    if (command === "export") {
      const archive = await application.relay.exportArchive({ exportedAt: new Date().toISOString() });
      const destination = writeArchive(filename, archive);
      process.stdout.write(`${JSON.stringify({ command, destination, digest: archive.digest })}\n`);
      return;
    }
    if (command === "verify") {
      process.stdout.write(`${JSON.stringify({ command, report: await application.relay.verifyIntegrity() })}\n`);
      return;
    }
    const archive = readArchive(filename);
    const mode = command === "restore-replace" ? "replace" : "validate";
    process.stdout.write(
      `${JSON.stringify({ command, result: await application.relay.restoreArchive(archive, { mode }) })}\n`
    );
  } finally {
    application.close();
  }
}

run().catch((error) => {
  process.stderr.write(`Relay admin command failed: ${error.message}\n`);
  process.exitCode = 1;
});
