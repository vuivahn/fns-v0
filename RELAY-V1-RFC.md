# Relay v1 RFC (draft)

## Status and boundary

This document prepares a future **Relay v1**. It does not add a relay to
Store Interface v0, and it does not change the frozen `FnsStore` contract.
Relay v1 must live in a separate package/service and depend on the v0 store
interface as a read-only backend.

Store Interface v0 deliberately excludes relay protocol design, pagination,
streaming, caching, federation, write/delete/sync APIs, ranking, and trust
policy. This RFC is therefore a planning boundary, not a protocol
specification or a deployment authorization.

## Proposed read-only shape (not yet a wire contract)

The service would expose only the existing store queries:

- fetch one object by canonical `objectId`;
- discover bindings by `(context, alias)`;
- discover releases by `binding`;
- discover commune updates by `commune`;
- return the v0 `Candidate` envelope and its completeness/provenance metadata
  without silently selecting a head or ranking results.

Exact paths, media types, pagination cursors, error payloads, authentication,
and response-size limits are deferred until the decisions below are recorded.
Malformed-but-addressable objects remain a store concern and must not be
revalidated as a condition of relay lookup.

## Safety controls for an eventual service

- Start with no write endpoints and database credentials that cannot write.
- Terminate TLS at a managed edge; redirect/reject insecure public traffic.
- Apply authentication, authorization, rate limits, body/query limits, and
  per-tenant quotas before store access.
- Use canonical ObjectId/request validation, bounded pagination, structured
  errors, and no stack traces or sensitive payloads in responses.
- Emit structured logs, metrics, traces, health/readiness checks, and audit
  events while redacting credentials and private object content.
- Encrypt backups, test restoration regularly, document runbooks, and alert on
  availability, latency, error rate, storage integrity, and backup failures.
- Keep secrets outside Git and inject them through the chosen deployment
  platform's secret manager.

## Decisions required before implementation or deployment

| Decision                                     | Why it cannot be assumed                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Authentication and authorization             | Determines whether data is public, signed-in, tenant-scoped, or operator-only.                 |
| Hosting and TLS ownership                    | Determines cloud account, network boundary, certificates, monitoring, and incident access.     |
| Storage topology                             | Determines whether SQLite is single-node only or a durable replicated service is required.     |
| RPO, RTO, retention, and data classification | Determines backup frequency, restore design, encryption, and operational cost.                 |
| Public wire contract                         | Determines versioning, media type, pagination, cache semantics, and compatibility commitments. |
| Abuse and privacy policy                     | Determines rate limits, logging/redaction, deletion process, and response limits.              |
| License and ownership                        | Determines reuse, contribution, and operating responsibility.                                  |

## Suggested delivery sequence

1. Record the above decisions in an approved ADR/threat model.
2. Create a separate `relay-v1` package with contract tests against the shared
   Store conformance fixtures.
3. Run it privately with read-only credentials, monitoring, encrypted backups,
   and a tested restore procedure.
4. Promote only after load, security, recovery, and compatibility gates pass.

The included `Dockerfile.ci` is intentionally a local/CI test container only:
it exposes no ports, contains no secrets, and is not a production deployment
image.
