# FNS public Relay v1 application

This directory contains the AGPL-3.0-or-later HTTP application. It is distinct
from the MPL-2.0 contract and adapter packages it uses.

Reads are anonymous. `POST /v1/publications` requires a scoped, expiring,
Relay-local bearer capability; no FNS identity, trust, authority, or signature
is read or produced by this application.

The application is not a canonical, default, or trusted FNS Relay. Deployments
must add TLS termination, rate limiting, secrets management, and observability
at their chosen edge/platform before exposing it publicly.

For the production local-reference image, mounted-volume layout, source-offer
endpoint, read-only root filesystem, and release smoke, see
[DEPLOYMENT.md](DEPLOYMENT.md). The public image requires an immutable source
offer URL and exposes it at `GET /.well-known/fns-source`.

## Local reference profile

The executable starts only the local reference profile: SQLite candidate data,
a filesystem blob directory, and a separate SQLite capability database. It
binds to `127.0.0.1:8080` by default; public exposure must be an explicit edge
deployment decision.

```powershell
$env:FNS_RELAY_CANDIDATES_DB = "C:\relay-data\candidates.sqlite"
$env:FNS_RELAY_CAPABILITY_DB = "C:\relay-data\capabilities.sqlite"
$env:FNS_RELAY_BLOB_DIR = "C:\relay-data\blobs"
$env:FNS_RELAY_CAPABILITY_PEPPER = "inject-at-least-32-secret-bytes"
$env:FNS_RELAY_CURSOR_SECRET = "inject-a-different-32-byte-cursor-secret"
npm.cmd --prefix relay-v1/apps/public-relay run start
```

`FNS_RELAY_LISTEN_HOST`, `FNS_RELAY_PORT`, `FNS_RELAY_DEFAULT_PAGE_SIZE`,
`FNS_RELAY_MAX_PAGE_SIZE`, `FNS_RELAY_MAX_REQUEST_BYTES`,
`FNS_RELAY_MAX_RESPONSE_BYTES`, and `FNS_RELAY_MAX_URL_BYTES` are optional.
The candidate and capability databases must be different files. Treat the two
secret values as deployment secrets: never commit them or put them in an
archive. A deployment may instead set
`FNS_RELAY_CAPABILITY_PEPPER_FILE` and `FNS_RELAY_CURSOR_SECRET_FILE` to
read-only secret files; setting a direct value and its `_FILE` counterpart at
the same time fails closed. Secret files are read as raw bytes, with one final
LF (or CRLF) ignored.

`GET /healthz` is process health. `GET /readyz` performs only lightweight
candidate/blob/capability reachability checks; scheduled admin verification is
the expensive integrity and archive check.

## Admin operations

The local application supplies a backend-neutral archive CLI. `export` refuses
to overwrite an existing file, and destructive restoration needs an explicit
confirmation flag.

```powershell
npm.cmd --prefix relay-v1/apps/public-relay run admin -- export C:\relay-backups\relay.json
npm.cmd --prefix relay-v1/apps/public-relay run admin -- verify
npm.cmd --prefix relay-v1/apps/public-relay run admin -- restore-validate C:\relay-backups\relay.json
npm.cmd --prefix relay-v1/apps/public-relay run admin -- restore-replace C:\relay-backups\relay.json --confirm-replace
```

Archive commands need only `FNS_RELAY_CANDIDATES_DB` and
`FNS_RELAY_BLOB_DIR`, so a backup job receives neither bearer-authentication
secret. `export`, `verify`, and `restore-validate` open candidate/blob storage
read-only; `restore-replace` is a maintenance operation and must not run
against a live Relay writer.

Issue a publication capability through the operator-only CLI, not an HTTP
endpoint. It needs only `FNS_RELAY_CAPABILITY_DB` and the capability pepper;
it writes the raw token to stdout once, so capture it only through a secure
operator channel.

```powershell
$expires = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600
npm.cmd --prefix relay-v1/apps/public-relay run admin -- issue-capability $expires relay:publication:create
npm.cmd --prefix relay-v1/apps/public-relay run admin -- revoke-capability <capability-id>
```

Archives contain immutable candidate data, coverage, blobs, and a digest. They
intentionally exclude bearer tokens, token hashes, peppers, signing keys,
operator accounts, and rate-limit state.
