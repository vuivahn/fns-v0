# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

FNS Store Interface v0 plus a separate Relay v1 foundation. The **Store** is an
asynchronous, **read-only** contract that preserves observable raw JSON
_candidates_ — it deliberately does **not** decide FNS identity, trust,
authority, ranking, validity, or a canonical head. Keep that boundary in mind
when extending anything: a store/relay is never canonical, default, or trusted.

Two independent layers, with a hard license/scope boundary between them:

- `src/` — **Store Interface v0** (MPL-2.0). The published library artifact
  (`fns-store-interface-v0`). The root `package.json` ships _only_ `src/`.
- `relay-v1/` — **Relay v1** foundation, private workspace material (not part of
  the v0 artifact):
  - `relay-v1/packages/relay-contract/` — protocol contracts, validation,
    archive format, and reusable **conformance** helpers (MPL-2.0).
  - `relay-v1/packages/relay-local/` — local reference adapters:
    `SQLiteCandidateStore`, `FileSystemBlobStore`, `SQLiteCapabilityStore`,
    `LocalPublicationPolicy`, and the `LocalReferenceRelay` orchestrator
    (MPL-2.0).
  - `relay-v1/apps/public-relay/` — the **AGPL-3.0-or-later** HTTP application.
    Anonymous reads; capability-gated publication.
- `specs/` and `test-vectors/` — CC0-1.0 specifications, JSON schemas, vectors.
- `ops/` — provider-neutral Linux host profile (Docker Compose, Nginx edge,
  systemd timers, backup/copy/restore-drill scripts). Ops docs are written in
  Korean.

No build step. Plain CommonJS (`"type": "commonjs"`), Node `>=22`, depends on
`better-sqlite3` and the frozen `fns-v0-validator` Core. ESLint 10 flat config
(`@eslint/js` recommended rules), Prettier. CI runs the quality gate on Node
22/24.

## Commands

```text
npm ci
npm run check            # lint (eslint --max-warnings=0) + prettier --check
npm test                 # node --test over all four test files
npm run test:strict       # same, with --unhandled-rejections=strict (CI uses this)
npm run test:relay        # only the two relay test files
npm run coverage         # c8 with thresholds: lines 90 / statements 90 / functions 85 / branches 75
npm run audit:prod        # npm audit --omit=dev --audit-level=high
npm run package:check     # npm pack --dry-run --ignore-scripts (verify shipped file set)
```

Run a **single test file** (the test runner is the built-in `node:test`):

```text
node --test test/sqlite-store.test.js
node --unhandled-rejections=strict --test test/relay-reference.test.js
```

There is no per-test-name filter convention; isolate by file. On PowerShell,
if the `npm` shim hits an execution-policy error, use `npm.cmd`.

Relay app lifecycle (run from the app dir, env-driven — see
`relay-v1/apps/public-relay/README.md`):

```text
npm.cmd --prefix relay-v1/apps/public-relay run start
npm.cmd --prefix relay-v1/apps/public-relay run admin -- export|verify|verify-archive|restore-validate|restore-replace|issue-capability|revoke-capability
```

Ops validation scripts exposed as npm tasks:
`check:host-relay` and `check:relay-funnel` run the deployment validators in
`scripts/`; `test:container` runs the relay container smoke.

## Store Interface v0 — the frozen contract

`src/fns-store.js` defines the abstract `FnsStore` with four async read methods:
`getObject`, `findAliasBindings`, `findAliasReleases`, `findCommuneDocuments`.
`src/index.js` is the public surface.

**This contract is frozen** (`STORE-INTERFACE-V0-FREEZE.md`). Changes must
preserve existing conformance vectors, fix spec errors, or move to a v1/adapter
surface — never silently alter semantics. The compatibility gate protects the
frozen `fns-v0-validator` Core (`resolveAlias`), JCS/ObjectId/signing-input
semantics, and the meaning of `complete`. Do **not** convert the frozen Core
API to async or change its semantics.

Implementation/concepts that span files:

- **Candidate** = `{ objectId, object }`. **Discovery envelope**
  (`version: "fns.store-discovery.v0"`) = `{ objects, complete, provenance, warnings }`.
  `complete` is _per-method/per-scope_ and means "the backend's observation of
  that scope is complete" — an empty result is **not** automatically complete,
  and `complete: false` does **not** mean global absence or object invalidity.
- **provenance is non-authoritative** — it carries no signature/trust/ranking
  meaning; store order/provenance never decides capability, fork, conflict, or
  trust priority.
- ObjectId-keyed **dedup** and conflicting-representation detection raise
  `StoreIntegrityError`. Candidate/diagnostic arrays are sorted by
  locale-independent **code point** order (`compareText`/`byDiagnostic`/`byObjectId`
  in `src/store-utils.js`). Malformed-but-addressable objects are kept and
  surfaced as diagnostics, separated from validator validity. Return values
  are **defensively copied** at call time.
- Three error categories (`src/errors.js`): `InvalidRequestError`
  (`E_STORE_INVALID_REQUEST`), `StoreAccessError` (`E_STORE_ACCESS`),
  `StoreIntegrityError` (`E_STORE_INTEGRITY`).

`src/memory-store.js` (`MemoryStore`) is the fixture/in-memory implementation
used by tests; it adds `put`/`setCompleteness` for fixture construction but its
read behavior is part of the frozen surface. It also **re-exports** the shared
helpers from `src/store-utils.js` (note: `src/adapter.js` imports those helpers
_through_ `./memory-store`).

`src/sqlite-store.js` is the persistent reference backend. `SCHEMA_VERSION = 1`
with a single `fns_store_objects` table plus payload-type/scoped indexes and a
`fns_store_coverage` table tracking per-(method, scope) completeness. The public
`SQLiteStore` surface is **read-only**; all operational methods — import,
integrity check, physical backup, logical export/restore, Relay page reads —
live on `SQLiteStoreAdmin` so the frozen v0 contract never grows operational
methods. See `SQLITE-STORE.md` for coverage/migration/backup/restore.

`src/adapter.js` is the async bridge to the frozen synchronous Core:

- `discoverFromStore({ context, alias }, store)` runs the three discovery
  methods, normalizes/validates each store envelope, dedups by ObjectId, and
  returns a `fns.store-discovery-set.v0` set (`bindings`, `releases`,
  `communeDocuments`, `objectStore`, `warnings`).
- `resolveAliasFromStore(query, store, options)` wraps the frozen
  `resolveAlias` from `fns-v0-validator`, returning its result unchanged under
  `resolution` plus method-scoped Store diagnostics under `storeDiscovery`.

The store validates every store response (envelope shape, canonical ObjectId,
JSON-value boundary, no conflicting representations) and rejects malformed
store output with `StoreIntegrityError` — a store implementation cannot smuggle
invalid data past the adapter.

## Tests and conformance

`test/store-conformance.js` is a reusable conformance harness driven by
`test-vectors/store-interface-v0.json`; `test/store-interface.test.js` asserts
the vector's named cases against `MemoryStore` (the case list itself is
asserted, so adding/removing a case is a deliberate, visible change).
`test/sqlite-store.test.js` exercises the SQLite backend. The same conformance
pattern is reused for Relay (`test/relay-reference.test.js`,
`test/public-relay.test.js` with `test/relay-support.js`), backed by
`relay-v1/packages/relay-contract/src/conformance.js`. When adding a store or
relay adapter, run it through the conformance harness rather than writing
bespoke tests.

## Relay v1

Relay is separate from the v0 package and is never canonical/default/trusted.
Reads are anonymous; `POST /v1/publications` requires a scoped, expiring,
Relay-local opaque bearer **capability** — implemented independently of FNS
identity/trust/signatures. HTTP routes (in `relay-v1/apps/public-relay/src/server.js`):
`GET /healthz`, `GET /readyz`, `GET /.well-known/fns-source` (immutable source
offer URL baked into the image), `GET /v1/objects/:id`,
`GET /v1/discovery/{alias-bindings,alias-releases,commune-documents}` (bounded
SQL pages, HMAC-protected expiring cursors via `cursor-codec.js`), and
capability-gated `POST /v1/publications`.

`LocalReferenceRelay` (`relay-v1/packages/relay-local/src/local-reference-relay.js`)
wires `candidateStore` + `blobStore` + `capabilityVerifier` +
`publicationPolicy`. Publication is immutable/idempotent (`publishImmutable` +
`putIfAbsent`), with conflict detection. It also exposes archive
export/restore (`createRelayArchive`/`verifyRelayArchive` in
`relay-contract/src/archive.js`), readiness, and integrity verification.

The local app (`local-reference-app.js`) is env-driven and fails closed on
misconfiguration: candidate and capability databases **must be distinct files**
(checked by canonical path _and_ device/inode), secrets may be set directly or
via `*_FILE` (but not both), and data paths must be writable. Archive commands
need only `FNS_RELAY_CANDIDATES_DB` + `FNS_RELAY_BLOB_DIR` so backup jobs
receive neither bearer secret; capability issuance is operator-CLI-only (never
an HTTP endpoint) and prints the raw token once. Archives intentionally exclude
bearer tokens, hashes, peppers, signing keys, and rate-limit state. The
production image requires an immutable source-offer URL (see
`relay-v1/apps/public-relay/DEPLOYMENT.md` and `SOURCE-OFFER.md`).

## License boundary (must respect when moving code)

Per `LICENSES.md`: **MPL-2.0** for Core (`src/`) and reusable Relay code
(`relay-contract`, `relay-local`); **AGPL-3.0-or-later** for the public Relay
application (`relay-v1/apps/public-relay/`); **CC0-1.0** for specs, schemas, and
vectors. Don't move AGPL app code into the MPL packages or vice versa — the
scope split is part of the license design, and `package:check` verifies the
shipped artifact contains only `src/`.
