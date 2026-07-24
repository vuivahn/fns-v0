"use strict";

// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require("assert");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { setTimeout } = require("timers");
const { URL } = require("url");

const repository = path.resolve(__dirname, "..");
const dockerExecutable = process.platform === "win32" ? "docker.exe" : "docker";
const archivePath = "/var/backups/fns-relay/archive/relay-container-smoke.json";

function redactArgument(argument) {
  return /^(FNS_RELAY_CAPABILITY_PEPPER|FNS_RELAY_CURSOR_SECRET)=/.test(argument)
    ? `${argument.slice(0, argument.indexOf("=") + 1)}[redacted]`
    : argument;
}

function commandText(args) {
  return [dockerExecutable, ...args.map(redactArgument)].join(" ");
}

function docker(args, { expectedStatus = 0, timeout = 120000, input = undefined } = {}) {
  const result = spawnSync(dockerExecutable, args, {
    cwd: repository,
    encoding: "utf8",
    env: process.env,
    input,
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error)
    throw new Error(
      `could not run ${commandText(args)}: ${
        result.error.code === "ENOENT" ? "Docker CLI is not installed or not on PATH" : result.error.message
      }`
    );
  const status = result.status ?? 1;
  if (status !== expectedStatus) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`command failed (exit ${status}): ${commandText(args)}${output ? `\n${output}` : ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cleanupDocker(args) {
  spawnSync(dockerExecutable, args, {
    cwd: repository,
    encoding: "utf8",
    env: process.env,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed before container smoke`);
  return result.stdout.trim();
}

function requireCleanSourceRevision() {
  if (gitOutput(["status", "--porcelain"]) !== "")
    throw new Error("container smoke requires a clean worktree so its immutable source offer matches the built image");
  const revision = gitOutput(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("could not determine a full Git revision for the source offer");
  return revision;
}

function randomName(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestSourceOffer(url, redirectsRemaining = 3) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "HEAD" }, (response) => {
      response.resume();
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        typeof response.headers.location === "string" &&
        redirectsRemaining > 0
      ) {
        requestSourceOffer(new URL(response.headers.location, url).toString(), redirectsRemaining - 1).then(
          resolve,
          reject
        );
        return;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
        return;
      }
      reject(new Error(`source offer returned HTTP ${response.statusCode}`));
    });
    request.setTimeout(10000, () => request.destroy(new Error("source offer request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function requestJson(baseUrl, method, pathname, { headers = {}, body = null } = {}) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        headers: body === null ? headers : { "content-type": "application/json", ...headers }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const representation = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(representation)
            });
          } catch (error) {
            reject(new Error(`response was not JSON: ${error.message}`));
          }
        });
      }
    );
    request.setTimeout(5000, () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", reject);
    if (body === null) request.end();
    else request.end(JSON.stringify(body));
  });
}

async function waitForOk(baseUrl, pathname) {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(baseUrl, "GET", pathname);
      if (response.status === 200) return response;
      lastError = new Error(`${pathname} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Relay did not become ready at ${pathname}: ${lastError?.message ?? "unknown error"}`);
}

function publishedPort(container) {
  const output = docker(["port", container, "8080/tcp"]).stdout.trim();
  const match = /:(\d+)\s*$/.exec(output);
  if (!match) throw new Error(`could not determine published Relay port from: ${output}`);
  return Number(match[1]);
}

function dataMountArguments({ candidateVolume, blobVolume, capabilityVolume = null, readonly = false }) {
  const suffix = readonly ? ",readonly" : "";
  const args = [
    "--mount",
    `type=volume,source=${candidateVolume},target=/var/lib/fns-relay/candidates${suffix}`,
    "--mount",
    `type=volume,source=${blobVolume},target=/var/lib/fns-relay/blobs${suffix}`
  ];
  if (capabilityVolume !== null)
    args.push("--mount", `type=volume,source=${capabilityVolume},target=/var/lib/fns-relay/capabilities${suffix}`);
  return args;
}

function serviceArguments({
  container,
  image,
  candidateVolume,
  blobVolume,
  capabilityVolume,
  secretVolume,
  detached = true
}) {
  const args = [
    "run",
    "--name",
    container,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    "128",
    "--publish",
    "127.0.0.1::8080",
    ...dataMountArguments({ candidateVolume, blobVolume, capabilityVolume }),
    "--mount",
    `type=volume,source=${secretVolume},target=/run/secrets,readonly`,
    "--env",
    "FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper",
    "--env",
    "FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret",
    image
  ];
  if (detached) args.splice(1, 0, "--detach");
  return args;
}

function oneShotArguments({
  candidateVolume,
  blobVolume,
  dataReadonly = false,
  archiveVolume = null,
  archiveTarget = null
}) {
  const args = [
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    ...dataMountArguments({ candidateVolume, blobVolume, readonly: dataReadonly })
  ];
  if (archiveVolume !== null && archiveTarget !== null) {
    args.push("--mount", `type=volume,source=${archiveVolume},target=${archiveTarget},readonly`);
  }
  return args;
}

function relayAdmin(container, args) {
  const output = docker(["exec", container, "node", "relay-v1/apps/public-relay/bin/admin.js", ...args]).stdout.trim();
  return JSON.parse(output);
}

function loadDiscoveryFixture() {
  const fixture = JSON.parse(fs.readFileSync(path.join(repository, "test-vectors", "store-interface-v0.json"), "utf8"));
  return fixture.objectIds;
}

function assertImageBoundary(image, sourceOfferUrl) {
  const inspectedEnvironment = JSON.parse(
    docker(["image", "inspect", image, "--format", "{{json .Config.Env}}"]).stdout
  );
  assert.strictEqual(
    inspectedEnvironment.some((entry) => entry.startsWith("FNS_RELAY_CAPABILITY_PEPPER=")),
    false,
    "the image must not embed a capability pepper"
  );
  assert.strictEqual(
    inspectedEnvironment.some((entry) => entry.startsWith("FNS_RELAY_CURSOR_SECRET=")),
    false,
    "the image must not embed a cursor secret"
  );
  const inspection = [
    "const fs=require('fs');",
    "if(process.getuid()!==10001) process.exit(11);",
    "for(const file of ['/opt/fns-relay/LICENSE','/opt/fns-relay/relay-v1/apps/public-relay/LICENSE','/opt/fns-relay/relay-v1/apps/public-relay/SOURCE-OFFER.md','/usr/share/licenses/fns-relay/MPL-2.0.txt','/usr/share/licenses/fns-relay/AGPL-3.0-or-later.txt','/usr/share/doc/fns-relay/SOURCE-OFFER.md','/usr/share/doc/fns-relay/SOURCE-OFFER-URL']) if(!fs.existsSync(file)) process.exit(12);",
    `if(fs.readFileSync('/usr/share/doc/fns-relay/SOURCE-OFFER-URL','utf8').trim()!==${JSON.stringify(
      sourceOfferUrl
    )}) process.exit(15);`,
    "for(const file of ['/opt/fns-relay/test','/opt/fns-relay/test-vectors','/opt/fns-relay/.git','/opt/fns-relay/.env']) if(fs.existsSync(file)) process.exit(13);"
  ].join("");
  docker(["run", "--rm", "--entrypoint", "node", image, "-e", inspection]);
  const readOnlyProbe = [
    "const fs=require('fs');",
    "try { fs.writeFileSync('/opt/fns-relay/write-probe','x'); process.exit(14); }",
    "catch { process.exit(0); }"
  ].join("");
  docker([
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--entrypoint",
    "node",
    image,
    "-e",
    readOnlyProbe
  ]);
}

function initializeDataVolume(image, volume) {
  docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/volume`,
    "--entrypoint",
    "node",
    image,
    "-e",
    "const fs=require('fs');fs.chownSync('/volume',10001,10001);fs.chmodSync('/volume',0o750);"
  ]);
}

function initializeArchiveVolume(image, volume) {
  docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/volume`,
    "--entrypoint",
    "node",
    image,
    "-e",
    "const fs=require('fs');fs.mkdirSync('/volume/archive',{recursive:true,mode:0o750});fs.chownSync('/volume',10001,10001);fs.chmodSync('/volume',0o750);fs.chownSync('/volume/archive',10001,10001);fs.chmodSync('/volume/archive',0o750);"
  ]);
}

function initializeSecretVolume(image, volume, pepper, cursorSecret) {
  const script = [
    "const fs=require('fs');",
    "const bytes=fs.readFileSync(0);",
    "if(bytes.length!==64) process.exit(21);",
    "fs.writeFileSync('/volume/capability-pepper',bytes.subarray(0,32),{mode:0o400});",
    "fs.writeFileSync('/volume/cursor-secret',bytes.subarray(32),{mode:0o400});",
    "for(const file of ['/volume/capability-pepper','/volume/cursor-secret']) { fs.chownSync(file,10001,10001); fs.chmodSync(file,0o400); }",
    "fs.chownSync('/volume',10001,10001);fs.chmodSync('/volume',0o500);"
  ].join("");
  docker(
    [
      "run",
      "--rm",
      "--interactive",
      "--user",
      "0:0",
      "--mount",
      `type=volume,source=${volume},target=/volume`,
      "--entrypoint",
      "node",
      image,
      "-e",
      script
    ],
    { input: Buffer.concat([pepper, cursorSecret]) }
  );
}

function makeBadOwnershipVolume(image, volume) {
  const script = ["const fs=require('fs');", "fs.chownSync('/volume',0,0);", "fs.chmodSync('/volume',0o555);"].join("");
  docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/volume`,
    "--entrypoint",
    "node",
    image,
    "-e",
    script
  ]);
}

async function main() {
  docker(["version", "--format", "{{.Server.Version}}"]);
  const revision = requireCleanSourceRevision();
  const sourceOfferUrl = `https://github.com/vuivahn/fns-v0/archive/${revision}.tar.gz`;
  await requestSourceOffer(sourceOfferUrl);
  const unique = randomName("fns-relay-smoke");
  const image = `${unique}:latest`;
  const sourceContainer = `${unique}-source`;
  const targetContainer = `${unique}-target`;
  const badContainer = `${unique}-bad`;
  const sourceCandidateVolume = `${unique}-source-candidates`;
  const sourceBlobVolume = `${unique}-source-blobs`;
  const sourceCapabilityVolume = `${unique}-source-capabilities`;
  const sourceSecretVolume = `${unique}-source-secrets`;
  const targetCandidateVolume = `${unique}-target-candidates`;
  const targetBlobVolume = `${unique}-target-blobs`;
  const targetCapabilityVolume = `${unique}-target-capabilities`;
  const targetSecretVolume = `${unique}-target-secrets`;
  const archiveVolume = `${unique}-archives`;
  const badCandidateVolume = `${unique}-bad-candidates`;
  const badBlobVolume = `${unique}-bad-blobs`;
  const badCapabilityVolume = `${unique}-bad-capabilities`;
  const pepper = crypto.randomBytes(32);
  const cursorSecret = crypto.randomBytes(32);
  const targetPepper = crypto.randomBytes(32);
  const targetCursorSecret = crypto.randomBytes(32);
  try {
    process.stdout.write("Building public Relay image...\n");
    docker(
      [
        "build",
        "--file",
        "Dockerfile.relay",
        "--tag",
        image,
        "--build-arg",
        `FNS_RELAY_SOURCE_OFFER_URL=${sourceOfferUrl}`,
        "."
      ],
      { timeout: 300000 }
    );
    assertImageBoundary(image, sourceOfferUrl);
    for (const volume of [
      sourceCandidateVolume,
      sourceBlobVolume,
      sourceCapabilityVolume,
      sourceSecretVolume,
      targetCandidateVolume,
      targetBlobVolume,
      targetCapabilityVolume,
      targetSecretVolume,
      archiveVolume,
      badCandidateVolume,
      badBlobVolume,
      badCapabilityVolume
    ])
      docker(["volume", "create", volume]);
    for (const volume of [
      sourceCandidateVolume,
      sourceBlobVolume,
      sourceCapabilityVolume,
      targetCandidateVolume,
      targetBlobVolume,
      targetCapabilityVolume,
      badBlobVolume,
      badCapabilityVolume
    ])
      initializeDataVolume(image, volume);
    initializeArchiveVolume(image, archiveVolume);
    initializeSecretVolume(image, sourceSecretVolume, pepper, cursorSecret);
    initializeSecretVolume(image, targetSecretVolume, targetPepper, targetCursorSecret);
    makeBadOwnershipVolume(image, badCandidateVolume);

    process.stdout.write("Starting fresh Relay volume and checking migration/readiness...\n");
    docker(
      serviceArguments({
        container: sourceContainer,
        image,
        candidateVolume: sourceCandidateVolume,
        blobVolume: sourceBlobVolume,
        capabilityVolume: sourceCapabilityVolume,
        secretVolume: sourceSecretVolume
      })
    );
    const sourceBaseUrl = `http://127.0.0.1:${publishedPort(sourceContainer)}`;
    await waitForOk(sourceBaseUrl, "/healthz");
    const initialReadiness = await waitForOk(sourceBaseUrl, "/readyz");
    assert.strictEqual(initialReadiness.body.readiness.candidate.database, "ok");
    assert.strictEqual(initialReadiness.body.readiness.blobs.directory, "ok");
    assert.strictEqual(initialReadiness.body.readiness.capabilities.database, "ok");
    docker([
      "exec",
      sourceContainer,
      "node",
      "-e",
      [
        "const fs=require('fs');",
        "if(process.getuid()!==10001 || process.getgid()!==10001) process.exit(24);",
        "const command=fs.readFileSync('/proc/1/cmdline','utf8').split('\\0');",
        "if(!command.includes('relay-v1/apps/public-relay/bin/start.js')) process.exit(25);"
      ].join("")
    ]);
    const serviceEnvironment = JSON.parse(
      docker(["inspect", sourceContainer, "--format", "{{json .Config.Env}}"]).stdout
    );
    assert.strictEqual(
      serviceEnvironment.some((entry) => entry.startsWith("FNS_RELAY_CAPABILITY_PEPPER=")),
      false
    );
    assert.strictEqual(
      serviceEnvironment.some((entry) => entry.startsWith("FNS_RELAY_CURSOR_SECRET=")),
      false
    );
    assert.strictEqual(
      serviceEnvironment.includes("FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper"),
      true
    );
    assert.strictEqual(serviceEnvironment.includes("FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret"), true);
    docker([
      "exec",
      sourceContainer,
      "node",
      "-e",
      "const fs=require('fs');for(const file of ['/run/secrets/capability-pepper','/run/secrets/cursor-secret']) { const stat=fs.statSync(file); if(stat.uid!==10001 || (stat.mode&0o777)!==0o400) process.exit(22); }"
    ]);
    const sourceOffer = await requestJson(sourceBaseUrl, "GET", "/.well-known/fns-source");
    assert.strictEqual(sourceOffer.status, 200);
    assert.strictEqual(sourceOffer.body.correspondingSource, sourceOfferUrl);
    assert.strictEqual(sourceOffer.body.license, "AGPL-3.0-or-later");
    const rejectedSourceOverride = docker(
      [
        "run",
        "--rm",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m",
        "--mount",
        `type=volume,source=${sourceSecretVolume},target=/run/secrets,readonly`,
        "--env",
        "FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper",
        "--env",
        "FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret",
        "--env",
        "FNS_RELAY_SOURCE_OFFER_URL=https://github.com/vuivahn/fns-v0/tree/main",
        image
      ],
      { expectedStatus: 1, timeout: 10000 }
    );
    assert.match(`${rejectedSourceOverride.stdout}\n${rejectedSourceOverride.stderr}`, /sourceOfferUrl.*immutable/i);

    const issued = relayAdmin(sourceContainer, [
      "issue-capability",
      String(Math.floor(Date.now() / 1000) + 600),
      "relay:publication:create"
    ]);
    assert.match(issued.token, /^fnsr1\./);
    const { context, bindingA, bindingB } = loadDiscoveryFixture();
    const candidate = (objectId) => ({
      objectId,
      object: { payload: { type: "fns.alias.bind", context, alias: "container-smoke" } }
    });
    for (const objectId of [bindingA, bindingB]) {
      const published = await requestJson(sourceBaseUrl, "POST", "/v1/publications", {
        headers: { authorization: `Bearer ${issued.token}` },
        body: candidate(objectId)
      });
      assert.strictEqual(published.status, 201);
    }
    const firstPage = await requestJson(
      sourceBaseUrl,
      "GET",
      `/v1/discovery/alias-bindings?context=${encodeURIComponent(context)}&alias=container-smoke&limit=1`
    );
    assert.strictEqual(firstPage.status, 200);
    assert.strictEqual(firstPage.body.objects.length, 1);
    assert.strictEqual(firstPage.body.page.complete, false);
    const secondPage = await requestJson(
      sourceBaseUrl,
      "GET",
      `/v1/discovery/alias-bindings?context=${encodeURIComponent(context)}&alias=container-smoke&limit=1&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`
    );
    assert.strictEqual(secondPage.status, 200);
    assert.strictEqual(secondPage.body.objects.length, 1);
    assert.strictEqual(secondPage.body.page.complete, true);
    assert.deepStrictEqual(
      [...firstPage.body.objects, ...secondPage.body.objects].map((entry) => entry.objectId).sort(),
      [bindingA, bindingB].sort()
    );
    const liveVerification = relayAdmin(sourceContainer, ["verify"]);
    assert.strictEqual(liveVerification.report.blobs.blobs, 2);

    process.stdout.write("Exporting a live archive, stopping gracefully, and restarting the same volume...\n");
    docker([
      ...oneShotArguments({
        candidateVolume: sourceCandidateVolume,
        blobVolume: sourceBlobVolume,
        dataReadonly: true
      }),
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "-e",
      "if(require('fs').existsSync('/var/lib/fns-relay/capabilities/capabilities.sqlite')) process.exit(23)"
    ]);
    const exported = JSON.parse(
      docker([
        ...oneShotArguments({
          candidateVolume: sourceCandidateVolume,
          blobVolume: sourceBlobVolume,
          dataReadonly: true
        }),
        "--network",
        "none",
        "--mount",
        `type=volume,source=${archiveVolume},target=/var/backups/fns-relay`,
        "--entrypoint",
        "node",
        image,
        "relay-v1/apps/public-relay/bin/admin.js",
        "export",
        archivePath
      ]).stdout
    );
    assert.strictEqual(exported.command, "export");
    const validated = JSON.parse(
      docker([
        ...oneShotArguments({
          candidateVolume: sourceCandidateVolume,
          blobVolume: sourceBlobVolume,
          dataReadonly: true,
          archiveVolume,
          archiveTarget: "/restore"
        }),
        "--network",
        "none",
        "--entrypoint",
        "node",
        image,
        "relay-v1/apps/public-relay/bin/admin.js",
        "restore-validate",
        "/restore/archive/relay-container-smoke.json"
      ]).stdout
    );
    assert.strictEqual(validated.result.entries, 2);
    docker(["stop", "--time", "10", sourceContainer]);
    assert.strictEqual(docker(["inspect", sourceContainer, "--format", "{{.State.ExitCode}}"]).stdout.trim(), "0");
    docker(["start", sourceContainer]);
    await waitForOk(sourceBaseUrl, "/readyz");
    const persisted = await requestJson(sourceBaseUrl, "GET", `/v1/objects/${encodeURIComponent(bindingA)}`);
    assert.strictEqual(persisted.status, 200);
    assert.strictEqual(relayAdmin(sourceContainer, ["verify"]).report.blobs.blobs, 2);

    const archiveContents = docker([
      ...oneShotArguments({
        candidateVolume: targetCandidateVolume,
        blobVolume: targetBlobVolume,
        archiveVolume,
        archiveTarget: "/restore"
      }),
      "--entrypoint",
      "node",
      image,
      "-e",
      "process.stdout.write(require('fs').readFileSync('/restore/archive/relay-container-smoke.json','utf8'))"
    ]).stdout;
    assert.strictEqual(archiveContents.includes(issued.token), false);
    assert.strictEqual(archiveContents.includes(pepper.toString("base64url")), false);
    docker([
      ...oneShotArguments({
        candidateVolume: targetCandidateVolume,
        blobVolume: targetBlobVolume,
        archiveVolume,
        archiveTarget: "/restore"
      }),
      "--entrypoint",
      "node",
      image,
      "relay-v1/apps/public-relay/bin/admin.js",
      "restore-replace",
      "/restore/archive/relay-container-smoke.json",
      "--confirm-replace"
    ]);
    docker(
      serviceArguments({
        container: targetContainer,
        image,
        candidateVolume: targetCandidateVolume,
        blobVolume: targetBlobVolume,
        capabilityVolume: targetCapabilityVolume,
        secretVolume: targetSecretVolume
      })
    );
    const targetBaseUrl = `http://127.0.0.1:${publishedPort(targetContainer)}`;
    await waitForOk(targetBaseUrl, "/readyz");
    const restored = await requestJson(targetBaseUrl, "GET", `/v1/objects/${encodeURIComponent(bindingB)}`);
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(relayAdmin(targetContainer, ["verify"]).report.blobs.blobs, 2);

    process.stdout.write("Checking a bad data-volume ownership fails safely...\n");
    const badResult = docker(
      serviceArguments({
        container: badContainer,
        image,
        candidateVolume: badCandidateVolume,
        blobVolume: badBlobVolume,
        capabilityVolume: badCapabilityVolume,
        secretVolume: sourceSecretVolume,
        detached: false
      }),
      { expectedStatus: 1, timeout: 10000 }
    );
    assert.match(
      `${badResult.stdout}\n${badResult.stderr}`,
      /FNS_RELAY_(CANDIDATES_DB|CAPABILITY_DB|BLOB_DIR).*writable/i
    );
    process.stdout.write("Relay container smoke passed.\n");
  } finally {
    cleanupDocker(["rm", "--force", sourceContainer]);
    cleanupDocker(["rm", "--force", targetContainer]);
    cleanupDocker(["rm", "--force", badContainer]);
    cleanupDocker(["volume", "rm", "--force", sourceCandidateVolume]);
    cleanupDocker(["volume", "rm", "--force", sourceBlobVolume]);
    cleanupDocker(["volume", "rm", "--force", sourceCapabilityVolume]);
    cleanupDocker(["volume", "rm", "--force", sourceSecretVolume]);
    cleanupDocker(["volume", "rm", "--force", targetCandidateVolume]);
    cleanupDocker(["volume", "rm", "--force", targetBlobVolume]);
    cleanupDocker(["volume", "rm", "--force", targetCapabilityVolume]);
    cleanupDocker(["volume", "rm", "--force", targetSecretVolume]);
    cleanupDocker(["volume", "rm", "--force", archiveVolume]);
    cleanupDocker(["volume", "rm", "--force", badCandidateVolume]);
    cleanupDocker(["volume", "rm", "--force", badBlobVolume]);
    cleanupDocker(["volume", "rm", "--force", badCapabilityVolume]);
    cleanupDocker(["image", "rm", "--force", image]);
  }
}

main().catch((error) => {
  process.stderr.write(`Relay container smoke failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
