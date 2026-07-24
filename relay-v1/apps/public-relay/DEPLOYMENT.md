<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Public Relay local-reference deployment

This guide deploys the SQLite/filesystem reference profile. It is a strict
single-writer profile: run exactly one application replica against a given
candidate database, blob directory, and capability database. Do not place
those paths on NFS, SMB, desktop-sync storage, object storage mounts, or any
shared filesystem. Do not overlap old and new containers during an update;
stop the old writer before starting the replacement.

The first public instance should be a single Linux container host or VM with
durable block-backed storage and a separate TLS/rate-limit edge. It does not
make that Relay canonical, default, trusted, or an FNS-wide dependency.

## Build and source offer

Build from the repository root. The source-offer argument is deliberately a
full immutable source archive URL; the Dockerfile rejects a blank, branch, or
tag URL.

```sh
docker build \
  --file Dockerfile.relay \
  --build-arg FNS_RELAY_SOURCE_OFFER_URL=https://github.com/vuivahn/fns-v0/archive/<40-lowercase-hex-commit>.tar.gz \
  --tag fns-public-relay:<immutable-release> \
  .
```

The public application exposes that value at `GET /.well-known/fns-source`.
It reads the root-owned, build-time source-offer record instead of a mutable
runtime setting; a conflicting runtime `FNS_RELAY_SOURCE_OFFER_URL` fails
startup. Verify the archive is anonymously reachable before publishing the
image.
The image also contains the full MPL-2.0 and AGPL-3.0-or-later texts under
`/usr/share/licenses/fns-relay/`. Never pass a capability token, pepper, cursor
secret, or private fixture as a build argument, image environment value, or
copied build-context file.

`Dockerfile.relay` uses an explicit `COPY` whitelist. It intentionally omits
tests, test vectors, Git metadata, local SQLite files, archives, `.env` files,
and local credentials even if they are present beside the build context.

## Persistent paths and permissions

Use separate persistent mounts when the platform supports them. The service
container runs as UID/GID `10001`; each writable mount must be owned by that
identity and must not be writable by unrelated host users.

| Container path                    | Service access                 | Purpose                                    | Archive behavior      |
| --------------------------------- | ------------------------------ | ------------------------------------------ | --------------------- |
| `/var/lib/fns-relay/candidates`   | read/write                     | candidate SQLite database and WAL sidecars | included logically    |
| `/var/lib/fns-relay/blobs`        | read/write                     | canonical JSON blob files                  | included logically    |
| `/var/lib/fns-relay/capabilities` | read/write                     | local token hashes, expiry, revocation     | deliberately excluded |
| `/var/backups/fns-relay`          | no mount for serving container | archive job mount; write under `archive/`  | archive storage only  |
| `/run/secrets`                    | read-only                      | pepper and cursor-secret files             | never archived        |

Losing the capability database invalidates existing capabilities; it must fail
closed and operators must issue replacements. It must not be reconstructed
from a logical Relay archive.

For named volumes, initialize the target directories with UID/GID `10001`.
For bind mounts, do that explicitly on the Linux host before startup. A
root-owned or read-only data mount is a deployment error: startup must fail
clearly instead of falling back to a path in the image filesystem.

## Serving container

The application must read secrets from read-only files rather than baking them
into the image. The `*_FILE` configuration below is the deployment interface;
the files should be supplied by the chosen secrets manager and contain at
least 32 bytes of secret material. Files are consumed as raw bytes; one final
LF (or CRLF) is ignored for secret-manager compatibility.

```sh
docker run --detach --name fns-relay \
  --read-only \
  --user 10001:10001 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --publish 127.0.0.1:8080:8080 \
  --mount type=volume,source=fns-relay-candidates,target=/var/lib/fns-relay/candidates \
  --mount type=volume,source=fns-relay-blobs,target=/var/lib/fns-relay/blobs \
  --mount type=volume,source=fns-relay-capabilities,target=/var/lib/fns-relay/capabilities \
  --mount type=bind,source=/run/fns-relay-secrets,target=/run/secrets,readonly \
  --env FNS_RELAY_CAPABILITY_PEPPER_FILE=/run/secrets/capability-pepper \
  --env FNS_RELAY_CURSOR_SECRET_FILE=/run/secrets/cursor-secret \
  fns-public-relay:<immutable-release>
```

Keep port 8080 private to the host or cluster. A reverse proxy or platform edge
is responsible for TLS, trusted forwarding headers, rate limits, request
filtering, access logs, metrics, and alerting. `GET /healthz` is liveness;
`GET /readyz` is storage readiness and must be configured separately.

Node is PID 1 and receives `SIGTERM` directly. Use a finite platform stop
grace period that is longer than the application's configured graceful-shutdown
deadline. A successful stop must exit zero after it stops accepting traffic and
closes SQLite handles.

## Archive, restore, and capability boundaries

Run archive work as a separate, one-shot data-admin container rather than in
the serving container. An export job mounts candidate/blob data read-only,
mounts `/var/backups/fns-relay` read/write, has no network, and receives no
capability pepper or cursor secret. A restore job mounts the archive read-only,
candidate/blob data read/write, and must use explicit replacement confirmation.

Exports may run while the Relay serves traffic: the candidate snapshot is
transactional, blobs are immutable, and publication writes a blob before it
makes its candidate visible. Each produced archive still requires digest
verification and an isolated restore drill. Do not restore into a live writer.

Capability issuance/revocation is a separate privileged operation: it may
mount only the capability database and the capability pepper, never archive
storage or Relay candidate/blob data. Archive contents intentionally omit
capabilities, peppers, cursor secrets, accounts, and rate-limit state.

## Required container smoke before release

Run the following against the actual target architecture and storage class:

1. Build the image and verify its OCI source label, license files, and source
   offer endpoint; confirm no private token or test fixture is present.
2. Start it with a fresh persistent volume under `--read-only`; prove PID 1
   and application commands run as UID/GID 10001.
3. Confirm fresh SQLite schema initialization, filesystem blob write/read,
   `/healthz`, and `/readyz`.
4. Issue a scoped expiring capability through the privileged admin path;
   publish candidates, then verify anonymous cursor-paginated reads.
5. Stop with `SIGTERM`, confirm graceful exit, restart on the same mounts, and
   verify the original candidate and blob remain readable.
6. Export while the serving Relay remains active; verify the archive digest.
   Restore it to fresh candidate/blob mounts and prove anonymous reads there.
7. Deliberately use a wrong owner or non-writable data mount and assert a
   clear non-zero startup failure.
8. Run the complete smoke on `linux/amd64`; additionally run it natively on
   `linux/arm64` before advertising that architecture.

Until this smoke succeeds on the intended production profile, the public
Relay deployment remains platform-integration pending.
