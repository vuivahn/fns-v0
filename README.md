# FNS Store Interface v0

This repository contains the frozen asynchronous, read-only `FnsStore` v0
contract, its memory and SQLite reference implementations, and a separate
Relay v1 foundation. A store preserves observable raw JSON candidates; it does
not decide FNS identity, trust, authority, ranking, validity, or a canonical
head.

## Repository boundary

- `src/`: MPL-2.0 Store Interface v0 and the SQLite reference backend.
- `relay-v1/packages/`: MPL-2.0 Relay contracts, conformance helpers, and
  local adapters.
- `relay-v1/apps/public-relay/`: the separate AGPL-3.0-or-later HTTP
  application.
- `specs/` and `test-vectors/`: CC0-1.0 specifications, schemas, and vectors.

The root npm package deliberately ships only `src/`. Relay packages are
private workspace material for now, not part of the v0 library artifact.

## Store v0

`FnsStore` exposes asynchronous `getObject`, `findAliasBindings`,
`findAliasReleases`, and `findCommuneDocuments` reads. `MemoryStore` supports
fixtures; `SQLiteStore` is the persistent reference backend. The public store
surface is read-only. Import, integrity, physical backup, logical export, and
Relay-only page reads live on `SQLiteStoreAdmin` so the frozen v0 contract does
not grow operational methods.

```js
const { SQLiteStore, SQLiteStoreAdmin, discoverFromStore } = require("fns-store-interface-v0");

const store = new SQLiteStore({ filename: "./data/fns.sqlite", source: "sqlite:local" });
const admin = new SQLiteStoreAdmin(store);

admin.importSnapshot({ entries: [], coverage: [] });
const discovery = await discoverFromStore({ context, alias }, store);
const portableSnapshot = admin.exportSnapshot();
store.close();
```

See [SQLite Store Guide](SQLITE-STORE.md) for coverage, migration, backup, and
restore details. `complete` in a discovery envelope means the backend's
observation of that scope is complete; an empty result is not automatically a
complete result.

## Relay v1 local reference

Relay is separate from the v0 package and is never canonical, default, or
trusted. Anonymous reads are available through the public HTTP application;
publication requires a scoped, expiring, Relay-local opaque bearer capability.
The capability implementation is deliberately independent of FNS identity,
trust, authority, signatures, and ranking.

```text
Relay contract (MPL-2.0)
├─ Local reference: SQLiteCandidateStore + FileSystemBlobStore
├─ Optional serverless profile: D1CandidateStore + R2ContentBlobStore (planned)
└─ Alternative scale profile: PostgreSQL + S3-compatible storage (planned)

Public Relay application (AGPL-3.0-or-later)
└─ anonymous GET reads, capability-gated POST publication
```

The implemented local profile has immutable/idempotent candidate publication,
conflict detection, durable filesystem blob staging, bounded SQL page reads,
HMAC-protected expiring cursors, health/readiness endpoints, logical archive
export/restore, and reusable storage conformance tests. The wire surface is
documented in [Relay v1 specification](specs/relay-v1/README.md).

To run the local app or create/validate/restore an archive, follow
[the public Relay application guide](relay-v1/apps/public-relay/README.md).
No D1/R2, PostgreSQL/S3, public cloud account, DNS, TLS edge, or public
deployment is claimed or configured in this repository yet.

## Verification

```text
npm ci
npm run check
npm run test:strict
npm run coverage
npm run audit:prod
npm run package:check
```

In PowerShell, use `npm.cmd` if the `npm` shim has an execution-policy issue.
CI runs the quality gate on Node.js 20, 22, and 24.

## Operations and next work

The operating profile records a primary failure-domain RPO of one hour, a
provider-loss RPO of up to 24 hours while off-provider copies remain daily, and
an RTO of four hours. It includes hourly backup, daily independent copy, and
regular isolated restore verification. A Relay outage is not an FNS-wide
outage.

Read [Infrastructure Roadmap](INFRASTRUCTURE-ROADMAP.md) for current status,
[Relay v1 RFC](RELAY-V1-RFC.md) for the protocol boundary, and
[operations guidance](ops/README.md) for recovery, SLO, and adapter-transition
criteria.

## License

The per-scope license map is in [LICENSES.md](LICENSES.md): MPL-2.0 for Core
and reusable Relay code, AGPL-3.0-or-later for the public Relay application,
and CC0-1.0 for specifications, schemas, and vectors.
