<!-- SPDX-License-Identifier: CC0-1.0 -->

# Relay v1 RFC

## Status

The local reference profile is implemented in \`relay-v1/\`; D1/R2 and
PostgreSQL/S3-compatible adapters remain planned. This RFC does not change the
frozen \`FnsStore\` v0 contract and does not authorize a public production
deployment by itself.

Relay is an optional discovery/publication service. No Relay is canonical,
default, trusted, or an FNS-wide dependency.

## License boundary

| Scope                                                  | License           |
| ------------------------------------------------------ | ----------------- |
| Relay contracts, local adapters, and conformance       | MPL-2.0           |
| Public HTTP application and operational implementation | AGPL-3.0-or-later |
| Specification, schemas, and vectors                    | CC0-1.0           |

The public application must stay physically separable from the MPL contract
and adapter packages. See [LICENSES.md](LICENSES.md).

## Read and publication model

\`\`\`text
GET /healthz
GET /readyz
GET /v1/objects/{objectId}
GET /v1/discovery/alias-bindings?context=&alias=&limit=&cursor=
GET /v1/discovery/alias-releases?binding=&limit=&cursor=
GET /v1/discovery/commune-documents?context=&limit=&cursor=
POST /v1/publications
\`\`\`

The read endpoints are anonymous. \`POST /v1/publications\` accepts one strict
JSON candidate and requires \`Authorization: Bearer fnsr1.{token-id}.{secret}\`.
Tokens are opaque, locally stored by ID plus a pepper-based HMAC, scoped,
expiring, and revocable. The raw bearer is returned only when created and is
never placed in a URL, log, error, trace, or logical archive.

Publication admission is Relay-local policy. The initial policy recognizes a
general publish scope and optional object/context scopes; it neither reads nor
creates FNS identity, trust, authority, signature, validation, ranking, or
head-selection claims. Another authentication/policy adapter can replace it
when it implements the same local admission boundary.

## Pagination and bounded work

\`complete\` in the existing store discovery envelope describes **coverage
completeness**. HTTP pagination independently returns:

\`\`\`json
{
"complete": false,
"page": { "complete": false, "nextCursor": "fnsrc1..." }
}
\`\`\`

Cursors are HMAC protected, route/query bound, and expire after five minutes by
default. Relay adapters must perform cursor-aware bounded reads; the SQLite
reference selects at most \`limit + 1\` rows to determine whether another page
exists. Public defaults are page size 100, maximum 1,000, URL 8 KiB, request
body 256 KiB, and response 1 MiB, all configurable per deployment.

## Storage and archive contract

The local profile uses:

- \`SQLiteCandidateStore\` as the enduring reference candidate backend;
- \`FileSystemBlobStore\` for content blobs;
- a separate SQLite capability database.

A blob is durably written before its candidate becomes visible. A crash can
leave an unreachable blob, but must not publish a candidate whose local blob
write failed. On POSIX the reference fsyncs file and directory metadata; on
Windows operators must validate the platform's file-flush semantics in restore
drills.

\`fns.relay-archive.v1\` is backend-neutral: it carries a versioned candidate
snapshot, matching blobs, an ISO UTC export time, and a SHA-256 digest over its
canonical payload. It excludes credentials, tokens, token hashes, peppers,
keys, operator accounts, rate-limit state, and audit logs. Restore defaults to
validation; a destructive replacement requires explicit \`replace\` mode and an
operator confirmation in the local CLI. Merge restore is intentionally not
specified.

## Deployment profiles

| Profile             | Candidate backend | Blob backend  | Status                                       |
| ------------------- | ----------------- | ------------- | -------------------------------------------- |
| Local reference     | SQLite            | filesystem    | Implemented                                  |
| Optional serverless | D1                | R2            | Contract target; Workers ESM adapter pending |
| Scale alternative   | PostgreSQL        | S3-compatible | Contract target; adapter pending             |

SQLite remains the permanent reference backend. PostgreSQL is a scale option,
not a default or semantically superior authority. Serverless is an optional
operating profile. Every adapter must pass the Relay contract/conformance suite
and implement versioned logical export/restore before it can be used.

## Operating objectives

- Primary failure-domain RPO: at most one hour through hourly verified backup.
- Provider-loss RPO: at most 24 hours while off-provider copy is daily.
- RTO: at most four hours.
- Daily off-provider copy and regular isolated restore tests are mandatory.

The two RPO values are intentionally distinct. Achieving one-hour RPO for a
complete provider loss would require hourly off-provider replication, which is
not currently chosen. The runbook and adapter gates are in \`ops/\`.

## Conditions before public deployment

1. Select a hosting account, TLS edge, rate limit, secrets manager,
   observability stack, retention, and incident owner.
2. Set concrete traffic/latency/error SLOs after measuring the target profile.
3. Automate hourly archives, daily independent copies, and isolated restore
   tests; retain their evidence.
4. Complete an abuse/privacy policy and an admission-token issuance/revocation
   procedure.
5. Test the actual cloud adapter, migration/rollback, and off-provider restore
   before routing public traffic.
