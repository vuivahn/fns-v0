# FNS Relay v1 specification

This CC0-1.0 specification defines an interoperability boundary. It does not
define a canonical/default/trusted Relay or an FNS identity, trust, authority,
ranking, or validation service.

## HTTP reference surface

The AGPL public Relay reference application exposes:

```text
GET  /healthz
GET  /readyz
GET  /v1/objects/{objectId}
GET  /v1/discovery/alias-bindings?context={objectId}&alias={string}&limit={n}&cursor={opaque}
GET  /v1/discovery/alias-releases?binding={objectId}&limit={n}&cursor={opaque}
GET  /v1/discovery/commune-documents?context={objectId}&limit={n}&cursor={opaque}
POST /v1/publications
```

The four discovery/object reads are anonymous. A deployment must provide TLS,
rate limiting, edge request controls, secret management, and observability
before public exposure.

`POST /v1/publications` receives one JSON candidate
(`objectId`, raw JSON `object`) and requires an
`Authorization: Bearer fnsr1.{token-id}.{secret}` capability. The initial
capability is Relay-local, scoped, expiring, revocable, and deliberately
unrelated to FNS identity, signatures, trust, or authority. It must never be
placed in URLs, logs, errors, traces, or logical exports.

## Discovery pagination

Store `complete` is **coverage completeness**: whether a backend completely
observed the requested discovery scope. HTTP page completion is a separate
claim:

```json
{
  "complete": false,
  "page": {
    "complete": false,
    "nextCursor": "fnsrc1..."
  }
}
```

Cursors are opaque, HMAC protected, route/query bound, and expire after five
minutes in the reference app. The default page size is 100 and the maximum is
1,000. A public Relay must use cursor-aware bounded adapter queries; it must
not first materialize an unbounded discovery result and trim it afterward.

## Portable archive

`fns.relay-archive.v1` contains a `fns.store-export.v1` candidate snapshot,
exactly matching blobs, an ISO UTC timestamp, and a SHA-256 canonical digest.
It excludes capability records, bearer tokens, token hashes, peppers, signing
keys, rate-limit state, operator accounts, and audit logs.

Restore is validation-only by default. A destructive replacement requires
explicit `replace` mode. Merge restore is intentionally unspecified until its
completeness and immutable-conflict behavior can be defined safely.

See [schemas](schemas/) and [vectors](vectors/).

## Backend profiles

- Local reference: `SQLiteCandidateStore` + `FileSystemBlobStore`.
- Optional serverless: `D1CandidateStore` + `R2ContentBlobStore` in a Workers
  ESM adapter package.
- Alternative scale adapters: PostgreSQL candidate storage and S3-compatible
  content blobs.

Every profile must implement MPL-2.0 Relay contracts/conformance and
backend-neutral export/restore. SQLite remains the permanent reference
backend; PostgreSQL is a scale alternative, not a semantically superior
source.
