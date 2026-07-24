# FNS public Relay v1 application

This directory contains the AGPL-3.0-or-later HTTP application. It is distinct
from the MPL-2.0 contract and adapter packages it uses.

Reads are anonymous. `POST /v1/publications` requires a scoped, expiring,
Relay-local bearer capability; no FNS identity, trust, authority, or signature
is read or produced by this application.

The application is not a canonical, default, or trusted FNS Relay. Deployments
must add TLS termination, rate limiting, secrets management, and observability
at their chosen edge/platform before exposing it publicly.

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
archive.

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

Archives contain immutable candidate data, coverage, blobs, and a digest. They
intentionally exclude bearer tokens, token hashes, peppers, signing keys,
operator accounts, and rate-limit state.
