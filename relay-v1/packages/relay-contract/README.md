# Relay v1 contract

This package is MPL-2.0 and defines backend-neutral Relay ports. It does not
define FNS identity, trust, authority, ranking, or a canonical Relay.

The contract separates:

- immutable candidate storage;
- content blob storage;
- Relay-local publication admission and capability verification;
- portable logical archive validation.

Provider adapters must preserve the v0 discovery envelope exactly. In
particular, coverage completeness and HTTP-page completeness are different
claims and must not be merged.

For public discovery, a Relay candidate adapter also exposes page-aware query
methods. They accept an exclusive `afterObjectId` cursor position and a bounded
limit, return a normal v0 envelope plus an internal `hasMore` witness, and must
not materialize an unbounded result only to trim it in the HTTP layer. The
public application removes `hasMore` and publishes its independent
`page.complete`/`page.nextCursor` member.

`runRelayStorageConformance()` checks immutable/idempotent publication, blob
conflict rejection, a bounded page call, and logical export compatibility.
