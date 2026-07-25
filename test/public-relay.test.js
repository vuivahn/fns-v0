"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const { once } = require("events");
const path = require("path");
const test = require("node:test");
const { URL } = require("url");
const { CursorCodec } = require("../relay-v1/apps/public-relay/src/cursor-codec");
const {
  createLocalReferenceRelayApplication,
  readRequiredSecret
} = require("../relay-v1/apps/public-relay/src/local-reference-app");
const { createPublicRelayServer } = require("../relay-v1/apps/public-relay/src/server");
const { RelayProtocolError } = require("../relay-v1/packages/relay-contract/src/errors");
const { PUBLISH_SCOPE } = require("../relay-v1/packages/relay-local/src");
const { binding, bindingA, bindingB, context, release, releaseObject } = require("./store-conformance");
const {
  createLocalReferenceRelay,
  removeTemporaryRelayDirectory,
  temporaryRelayDirectory
} = require("./relay-support");

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
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    if (body !== null) request.end(JSON.stringify(body));
    else request.end();
  });
}

function runRelayAdmin(environment, arguments_) {
  const script = path.join(__dirname, "..", "relay-v1", "apps", "public-relay", "bin", "admin.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...environment, NODE_V8_COVERAGE: "" }
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

test("public Relay allows anonymous bounded reads but requires Relay-local bearer publication", async () => {
  const directory = temporaryRelayDirectory();
  const now = () => Date.UTC(2026, 0, 1, 0, 0, 0);
  const reference = createLocalReferenceRelay(directory, { now });
  const capability = reference.capabilityStore.create({
    scopes: [PUBLISH_SCOPE],
    expiresAt: Math.floor(now() / 1000) + 600
  });
  const server = createPublicRelayServer({
    relay: reference.relay,
    cursorSecret: "public-relay-cursor-secret-must-be-at-least-32-bytes",
    now,
    defaultPageSize: 1,
    maximumPageSize: 2,
    sourceOfferUrl: "https://github.com/vuivahn/fns-v0/archive/0123456789abcdef0123456789abcdef01234567.tar.gz"
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await requestJson(baseUrl, "POST", "/v1/publications", {
      body: { objectId: bindingA, object: binding() }
    });
    assert.strictEqual(unauthorized.status, 401);
    assert.strictEqual(unauthorized.body.error.code, "E_RELAY_AUTHENTICATION");

    for (const objectId of [bindingA, bindingB]) {
      const published = await requestJson(baseUrl, "POST", "/v1/publications", {
        headers: { authorization: `Bearer ${capability.token}` },
        body: { objectId, object: binding() }
      });
      assert.strictEqual(published.status, 201);
    }
    for (const candidate of [
      { objectId: release, object: releaseObject },
      { objectId: context, object: { payload: { type: "fns.commune.genesis" } } }
    ]) {
      const published = await requestJson(baseUrl, "POST", "/v1/publications", {
        headers: { authorization: `Bearer ${capability.token}` },
        body: candidate
      });
      assert.strictEqual(published.status, 201);
    }

    const object = await requestJson(baseUrl, "GET", `/v1/objects/${encodeURIComponent(bindingA)}`);
    assert.strictEqual(object.status, 200);
    assert.strictEqual(object.body.objectId, bindingA);
    assert.strictEqual(object.headers["x-content-type-options"], "nosniff");

    const firstPage = await requestJson(
      baseUrl,
      "GET",
      `/v1/discovery/alias-bindings?context=${encodeURIComponent(context)}&alias=alice&limit=1`
    );
    assert.strictEqual(firstPage.status, 200);
    assert.strictEqual(firstPage.body.complete, false);
    assert.strictEqual(firstPage.body.page.complete, false);
    assert.strictEqual(firstPage.body.objects.length, 1);
    const secondPage = await requestJson(
      baseUrl,
      "GET",
      `/v1/discovery/alias-bindings?context=${encodeURIComponent(context)}&alias=alice&limit=1&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`
    );
    assert.strictEqual(secondPage.status, 200);
    assert.strictEqual(secondPage.body.page.complete, true);
    assert.strictEqual(secondPage.body.objects.length, 1);

    const releases = await requestJson(
      baseUrl,
      "GET",
      `/v1/discovery/alias-releases?binding=${encodeURIComponent(bindingA)}`
    );
    assert.strictEqual(releases.status, 200);
    assert.deepStrictEqual(
      releases.body.objects.map((candidate) => candidate.objectId),
      [release]
    );
    const communeDocuments = await requestJson(
      baseUrl,
      "GET",
      `/v1/discovery/commune-documents?context=${encodeURIComponent(context)}`
    );
    assert.strictEqual(communeDocuments.status, 200);
    assert.deepStrictEqual(
      communeDocuments.body.objects.map((candidate) => candidate.objectId),
      [context]
    );

    const mismatchedCursor = await requestJson(
      baseUrl,
      "GET",
      `/v1/discovery/alias-bindings?context=${encodeURIComponent(context)}&alias=other&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`
    );
    assert.strictEqual(mismatchedCursor.status, 400);

    const health = await requestJson(baseUrl, "GET", "/healthz");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(
      health.headers.link,
      '<https://github.com/vuivahn/fns-v0/archive/0123456789abcdef0123456789abcdef01234567.tar.gz>; rel="source"'
    );
    const sourceOffer = await requestJson(baseUrl, "GET", "/.well-known/fns-source");
    assert.strictEqual(sourceOffer.status, 200);
    assert.deepStrictEqual(sourceOffer.body, {
      license: "AGPL-3.0-or-later",
      correspondingSource: "https://github.com/vuivahn/fns-v0/archive/0123456789abcdef0123456789abcdef01234567.tar.gz"
    });
    const ready = await requestJson(baseUrl, "GET", "/readyz");
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(ready.body.readiness.candidate.database, "ok");
    assert.strictEqual(ready.body.readiness.blobs.directory, "ok");
    assert.strictEqual(ready.body.readiness.capabilities.database, "ok");

    const malformedPath = await requestJson(baseUrl, "GET", "/v1/objects/%E0%A4%A");
    assert.strictEqual(malformedPath.status, 400);
    assert.strictEqual(
      malformedPath.headers.link,
      '<https://github.com/vuivahn/fns-v0/archive/0123456789abcdef0123456789abcdef01234567.tar.gz>; rel="source"'
    );
    const overlongUrl = await requestJson(baseUrl, "GET", `/v1/objects/${"a".repeat(9000)}`);
    assert.strictEqual(overlongUrl.status, 413);
    const methodNotAllowed = await requestJson(baseUrl, "PUT", "/v1/publications");
    assert.strictEqual(methodNotAllowed.status, 405);
    const unknownV1Route = await requestJson(baseUrl, "GET", "/v1/does-not-exist");
    assert.strictEqual(unknownV1Route.status, 404);
    const unknownRoute = await requestJson(baseUrl, "GET", "/not-a-relay-route");
    assert.strictEqual(unknownRoute.status, 404);
  } finally {
    server.close();
    await once(server, "close");
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("public Relay cursors reject signed payloads with a non-JSON query", () => {
  const secret = "public-relay-cursor-secret-must-be-at-least-32-bytes";
  const codec = new CursorCodec({ secret, now: () => Date.UTC(2026, 0, 1, 0, 0, 0) });
  const payload = {
    version: 1,
    route: "/v1/discovery/alias-bindings",
    query: undefined,
    lastObjectId: bindingA,
    expiresAt: Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000) + 60
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  assert.throws(
    () =>
      codec.parse(`fnsrc1.${encodedPayload}.${signature}`, {
        route: "/v1/discovery/alias-bindings",
        query: { context: context, alias: "alice" }
      }),
    RelayProtocolError
  );
});

test("public Relay local profile requires isolated storage and secret configuration", () => {
  const directory = temporaryRelayDirectory();
  const secretDirectory = path.join(directory, "secrets");
  const invalidParent = path.join(directory, "not-a-directory");
  const capabilityPepperFile = Buffer.alloc(32, 0x61);
  const cursorSecretFile = Buffer.alloc(32, 0x62);
  const environment = {
    FNS_RELAY_CANDIDATES_DB: path.join(directory, "candidates.sqlite"),
    FNS_RELAY_CAPABILITY_DB: path.join(directory, "capabilities.sqlite"),
    FNS_RELAY_BLOB_DIR: path.join(directory, "blobs"),
    FNS_RELAY_CAPABILITY_PEPPER: "local-reference-capability-pepper-32-bytes-minimum",
    FNS_RELAY_CURSOR_SECRET: "public-relay-cursor-secret-must-be-at-least-32-bytes",
    FNS_RELAY_DEFAULT_PAGE_SIZE: "2",
    FNS_RELAY_MAX_PAGE_SIZE: "3"
  };
  let application;
  try {
    fs.mkdirSync(secretDirectory);
    fs.writeFileSync(
      path.join(secretDirectory, "capability-pepper"),
      Buffer.concat([capabilityPepperFile, Buffer.from("\n")])
    );
    fs.writeFileSync(path.join(secretDirectory, "cursor-secret"), Buffer.concat([cursorSecretFile, Buffer.from("\n")]));
    fs.writeFileSync(invalidParent, "not a directory");
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: { ...environment, FNS_RELAY_CAPABILITY_DB: environment.FNS_RELAY_CANDIDATES_DB }
        }),
      RelayProtocolError
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: { ...environment, FNS_RELAY_DEFAULT_PAGE_SIZE: "4" }
        }),
      RelayProtocolError
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: {
            ...environment,
            FNS_RELAY_CANDIDATES_DB: path.join(invalidParent, "candidates.sqlite")
          }
        }),
      /FNS_RELAY_CANDIDATES_DB parent directory/
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: { ...environment, FNS_RELAY_SOURCE_OFFER_URL: "ftp://example.invalid/source" }
        }),
      RelayProtocolError
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: { ...environment, FNS_RELAY_SOURCE_OFFER_URL: "https://github.com/vuivahn/fns-v0/tree/main" }
        }),
      RelayProtocolError
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: {
            ...environment,
            FNS_RELAY_SOURCE_OFFER_URL:
              "https://github.com/vuivahn/fns-v0/archive/0123456789abcdef0123456789abcdef01234567.tar.gz"
          },
          builtSourceOfferUrl:
            "https://github.com/vuivahn/fns-v0/archive/abcdef0123456789abcdef0123456789abcdef01.tar.gz"
        }),
      /does not match/
    );
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: {
            ...environment,
            FNS_RELAY_CAPABILITY_PEPPER_FILE: path.join(secretDirectory, "capability-pepper")
          }
        }),
      /cannot both be set/
    );
    application = createLocalReferenceRelayApplication({ environment });
    assert.strictEqual(typeof application.server.listen, "function");
    assert.strictEqual(typeof application.relay.readiness, "function");
    application.close();
    application = createLocalReferenceRelayApplication({
      environment: {
        ...environment,
        FNS_RELAY_CAPABILITY_PEPPER: undefined,
        FNS_RELAY_CURSOR_SECRET: undefined,
        FNS_RELAY_CAPABILITY_PEPPER_FILE: path.join(secretDirectory, "capability-pepper"),
        FNS_RELAY_CURSOR_SECRET_FILE: path.join(secretDirectory, "cursor-secret")
      }
    });
    assert.strictEqual(typeof application.server.listen, "function");
  } finally {
    if (application) application.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("public Relay secret files trim one line ending without making raw secrets ambiguous", () => {
  const directory = temporaryRelayDirectory();
  const rawSecret = Buffer.alloc(32, 0x7a);
  const rawSecretEndingInCr = Buffer.concat([Buffer.alloc(31, 0x7a), Buffer.from([0x0d])]);
  const lfFilename = path.join(directory, "secret-lf");
  const crlfFilename = path.join(directory, "secret-crlf");
  const rawFilename = path.join(directory, "secret-raw");
  try {
    fs.writeFileSync(lfFilename, Buffer.concat([rawSecret, Buffer.from("\n")]));
    fs.writeFileSync(crlfFilename, Buffer.concat([rawSecret, Buffer.from("\r\n")]));
    fs.writeFileSync(rawFilename, rawSecretEndingInCr);
    assert.deepStrictEqual(
      readRequiredSecret({ FNS_RELAY_CURSOR_SECRET_FILE: lfFilename }, "FNS_RELAY_CURSOR_SECRET"),
      rawSecret
    );
    assert.deepStrictEqual(
      readRequiredSecret({ FNS_RELAY_CURSOR_SECRET_FILE: crlfFilename }, "FNS_RELAY_CURSOR_SECRET"),
      rawSecret
    );
    assert.deepStrictEqual(
      readRequiredSecret({ FNS_RELAY_CURSOR_SECRET_FILE: rawFilename }, "FNS_RELAY_CURSOR_SECRET"),
      rawSecretEndingInCr
    );
  } finally {
    removeTemporaryRelayDirectory(directory);
  }
});

test("public Relay rejects candidate and capability databases that resolve to the same file", () => {
  const directory = temporaryRelayDirectory();
  const candidateFilename = path.join(directory, "candidates.sqlite");
  const capabilityFilename = path.join(directory, "capabilities.sqlite");
  try {
    fs.writeFileSync(candidateFilename, "");
    fs.linkSync(candidateFilename, capabilityFilename);
    assert.throws(
      () =>
        createLocalReferenceRelayApplication({
          environment: {
            FNS_RELAY_CANDIDATES_DB: candidateFilename,
            FNS_RELAY_CAPABILITY_DB: capabilityFilename,
            FNS_RELAY_BLOB_DIR: path.join(directory, "blobs"),
            FNS_RELAY_CAPABILITY_PEPPER: "local-reference-capability-pepper-32-bytes-minimum",
            FNS_RELAY_CURSOR_SECRET: "public-relay-cursor-secret-must-be-at-least-32-bytes"
          }
        }),
      /resolve to distinct files/
    );
  } finally {
    removeTemporaryRelayDirectory(directory);
  }
});

test("public Relay returns 413 for bounded request and response payloads", async () => {
  const directory = temporaryRelayDirectory();
  const reference = createLocalReferenceRelay(directory);
  const server = createPublicRelayServer({
    relay: reference.relay,
    cursorSecret: "public-relay-cursor-secret-must-be-at-least-32-bytes",
    maximumRequestBytes: 8,
    maximumResponseBytes: 8
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requestLimit = await requestJson(baseUrl, "POST", "/v1/publications", {
      body: { objectId: bindingA, object: binding() }
    });
    assert.strictEqual(requestLimit.status, 413);
    const responseLimit = await requestJson(baseUrl, "GET", "/healthz");
    assert.strictEqual(responseLimit.status, 413);
  } finally {
    server.close();
    await once(server, "close");
    reference.close();
    removeTemporaryRelayDirectory(directory);
  }
});

test("public Relay admin CLI exports, verifies, and explicitly restores a portable archive", async () => {
  const directory = temporaryRelayDirectory();
  const archive = path.join(directory, "relay-archive.json");
  const environment = {
    FNS_RELAY_CANDIDATES_DB: path.join(directory, "candidates.sqlite"),
    FNS_RELAY_CAPABILITY_DB: path.join(directory, "capabilities.sqlite"),
    FNS_RELAY_BLOB_DIR: path.join(directory, "blobs"),
    FNS_RELAY_CAPABILITY_PEPPER: "local-reference-capability-pepper-32-bytes-minimum",
    FNS_RELAY_CURSOR_SECRET: "public-relay-cursor-secret-must-be-at-least-32-bytes"
  };
  try {
    const initialized = createLocalReferenceRelayApplication({ environment });
    initialized.close();
    const dataOnlyEnvironment = {
      FNS_RELAY_CANDIDATES_DB: environment.FNS_RELAY_CANDIDATES_DB,
      FNS_RELAY_BLOB_DIR: environment.FNS_RELAY_BLOB_DIR
    };
    const exported = await runRelayAdmin(dataOnlyEnvironment, ["export", archive]);
    assert.strictEqual(exported.code, 0, exported.stderr);
    assert.strictEqual(JSON.parse(exported.stdout).command, "export");
    const archiveOnly = await runRelayAdmin({}, ["verify-archive", archive]);
    assert.strictEqual(archiveOnly.code, 0, archiveOnly.stderr);
    assert.strictEqual(JSON.parse(archiveOnly.stdout).result.entries, 0);
    const validated = await runRelayAdmin(dataOnlyEnvironment, ["restore-validate", archive]);
    assert.strictEqual(validated.code, 0, validated.stderr);
    const rejectedReplacement = await runRelayAdmin(dataOnlyEnvironment, ["restore-replace", archive]);
    assert.strictEqual(rejectedReplacement.code, 1);
    const restored = await runRelayAdmin(dataOnlyEnvironment, ["restore-replace", archive, "--confirm-replace"]);
    assert.strictEqual(restored.code, 0, restored.stderr);
    const verified = await runRelayAdmin(dataOnlyEnvironment, ["verify"]);
    assert.strictEqual(verified.code, 0, verified.stderr);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const issued = await runRelayAdmin(
      {
        FNS_RELAY_CAPABILITY_DB: environment.FNS_RELAY_CAPABILITY_DB,
        FNS_RELAY_CAPABILITY_PEPPER: environment.FNS_RELAY_CAPABILITY_PEPPER
      },
      ["issue-capability", String(expiry), PUBLISH_SCOPE]
    );
    assert.strictEqual(issued.code, 0, issued.stderr);
    const issuedBody = JSON.parse(issued.stdout);
    assert.match(issuedBody.token, /^fnsr1\./);
    const revoked = await runRelayAdmin(
      {
        FNS_RELAY_CAPABILITY_DB: environment.FNS_RELAY_CAPABILITY_DB,
        FNS_RELAY_CAPABILITY_PEPPER: environment.FNS_RELAY_CAPABILITY_PEPPER
      },
      ["revoke-capability", issuedBody.capability.id]
    );
    assert.strictEqual(revoked.code, 0, revoked.stderr);
    assert.strictEqual(JSON.parse(revoked.stdout).revoked, true);
  } finally {
    removeTemporaryRelayDirectory(directory);
  }
});
