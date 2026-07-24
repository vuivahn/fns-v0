# Relay v1 local reference adapters

This MPL-2.0 package pairs a persistent `SQLiteStore` candidate backend with a
filesystem blob backend and a separate SQLite capability database. It is a
reference deployment profile, not a canonical, default, or trusted Relay.

The candidate database, blob directory, and capability database are separate
failure domains. A publication stores the blob before exposing the candidate;
an interrupted write can therefore leave an unreachable blob but not a visible
candidate lacking its blob. The filesystem reference fsyncs blob content before
linking it and fsyncs directory metadata on POSIX before candidate publication.
Windows uses the available file flush semantics; operators must validate the
actual storage behavior during restore drills.

Both SQLite databases use WAL with `synchronous = FULL` for the reference
profile. The SQLite adapter additionally has Relay-only page methods. They fetch at most
`limit + 1` candidates to prove a next cursor, rather than materializing a full
discovery envelope for a small HTTP page. The generic v0 `FnsStore` methods
remain unchanged and are intentionally not a pagination contract.

Run `readiness()` for lightweight storage reachability. Reserve
`verifyIntegrity()` for scheduled/admin use: it parses every stored candidate
and blob and builds a logical archive digest.
