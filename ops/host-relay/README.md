<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# First public Relay host profile

This is the provider-neutral first public Relay profile: one `linux/amd64`
Linux VM with durable local block storage, one SQLite/filesystem Relay writer,
an Nginx TLS/rate-limit edge, and independent encrypted archive copies. It is
not a canonical, default, trusted, or FNS-wide Relay.

The profile deliberately does not use the planned D1/R2 or PostgreSQL/S3
adapters. SQLite remains the reference backend, and the existing container
smoke has only established `linux/amd64` as a release-tested architecture.

```text
Internet
  │ TLS + rate limits
  ▼
Nginx edge :80/:443
  │ public + private Compose networks
  ▼
Relay :8080 (private network only)
  ├─ candidates/    bind mount, read/write, UID/GID 10001
  ├─ blobs/         bind mount, read/write, UID/GID 10001
  ├─ capabilities/  bind mount, read/write, UID/GID 10001
  └─ secrets/       bind mount, read-only

One-shot archive job
  ├─ candidates/ + blobs/ read-only
  ├─ no network, no capabilities, no secrets
  └─ verified archive/ write-only
```

## Host prerequisites

- An `amd64` Linux VM with a durable block-backed filesystem. Do not use NFS,
  SMB, desktop sync, object-storage mounts, or shared filesystems for Relay
  data.
- Docker Engine with the Compose plugin, `curl`, `sha256sum`, `flock`, and
  `rclone`. Access to Docker is host-root-equivalent; do not grant it to
  untrusted accounts.
- A DNS name, a TLS certificate workflow, and an independent off-provider
  destination configured as an encrypted `rclone` `crypt` remote.
- A chosen monitoring/alert receiver. The supplied systemd jobs expose clear
  unit failures and evidence records; notification transport stays a
  platform-owned integration.

Copy `relay.env.example` to `/etc/fns-relay/relay.env`, replace every example
value, and protect it as root-owned configuration. It must never contain a
secret value or cloud credential.

Treat an `rclone` remote name as a claim to verify, not proof of encryption or
independence. Before use, record the remote's `crypt` configuration, primary
and recovery provider/account boundaries, credential owner, retention/object
lock policy, and a successful destination-side checksum readback.

```sh
sudo install --directory --mode 0750 /etc/fns-relay /opt/fns-relay
sudo install --mode 0640 --owner root --group root relay.env.example /etc/fns-relay/relay.env
sudo install --directory --mode 0700 /etc/fns-relay/off-provider
```

The host initializer creates only directory ownership and modes. It never
generates or copies secret material.

```sh
set -a
. /etc/fns-relay/relay.env
set +a
sudo -E bash /opt/fns-relay/bin/initialize-host.sh
```

Provision two independent, at-least-32-byte raw secret files through the
chosen secret manager at `FNS_RELAY_SECRETS_DIR/capability-pepper` and
`FNS_RELAY_SECRETS_DIR/cursor-secret`. The directory must be `root:10001`
mode `0710`; each file must be `root:10001` mode `0440`. The Relay reads them
through its read-only mount. The archive, copy, and restore jobs never mount
this directory.

## Image and serving service

Check out the exact public Git commit in `FNS_RELAY_SOURCE_DIR`; it must be
clean. `build-image.sh` derives the immutable GitHub source offer from that
commit, verifies that the public source archive is reachable, builds the image,
and records its local image ID. `FNS_RELAY_NODE_IMAGE` is required to be a
reviewed digest, not the Dockerfile's mutable tag default. `verify-image.sh`
then blocks service startup if the local Relay tag has changed since that build
record; `FNS_RELAY_EDGE_IMAGE` must likewise be a reviewed registry digest.
Replace the all-zero example placeholders before either script can run.

```sh
set -a
. /etc/fns-relay/relay.env
set +a
sudo -E bash /opt/fns-relay/bin/build-image.sh
sudo docker compose --env-file /etc/fns-relay/relay.env -f /opt/fns-relay/compose.yaml --profile edge up --detach
```

The Compose file uses long bind syntax with `create_host_path: false` so Docker
cannot silently create a root-owned empty data directory. It keeps Relay on an
internal-only network; only the edge joins both the public and Relay networks
and publishes ports `80/443`. The SLO check uses the container healthcheck and
an in-container `/readyz` request, so it does not create a bypass around the
public edge.
Do not use `docker compose down -v`, volume prune, or overlapping old/new
writers during an update. The default container names and edge binds are
parameterized only so `target-host-smoke.sh` can use isolated names and
loopback high ports; production retains `fns-relay`, `fns-relay-edge`, and
ports 80/443.

## Tailscale Funnel home-server public beta

`compose.funnel.yaml` is a separate profile for a public beta on a host that
already uses ports `80/443`, such as a home server. It does not make this Relay
canonical, default, trusted, or an FNS-wide dependency. Funnel is a beta,
`ts.net`-addressed transport with provider-controlled bandwidth limits; keep a
custom-domain VM edge as the long-term production option.

```text
Internet HTTPS :8443
  -> Tailscale Funnel (TLS termination, PROXY protocol v2)
  -> 127.0.0.1:18080 on the home server
  -> Nginx Funnel edge :8080 (loopback bridge + private Relay network)
  -> Relay :8080 (private Docker network only)
```

The default public port is `8443`, leaving the host's `80/443` owner untouched.
The loopback edge accepts **only** PROXY protocol v2. This is deliberate:
Tailscale forwards the original client address in that header, allowing Nginx
to apply its read/publication rate limits per client instead of globally. Do
not replace `$proxy_protocol_addr` with an untrusted forwarded header and do
not publish the edge to `0.0.0.0`.

Docker does not make a published host port reachable when its target container
is attached only to an `internal: true` network. The Funnel edge therefore also
joins a project-private, non-internal `loopback` bridge, solely to make its
`127.0.0.1:18080` binding work. It is the edge's default gateway and defaults
any accidental port mapping to loopback; Relay remains off that bridge and has
no host port. The bridge creates no internet listener; the Compose port binding
is the enforced host boundary.

Before enabling it, confirm that the Tailscale node has MagicDNS/HTTPS and a
narrow Funnel policy grant (preferably on a dedicated Relay node or tag), and
that the selected public port is currently free. Copy
`relay.funnel.env.example` to the same protected `relay.env` location used by
the backup jobs, set reviewed image digests and durable paths, then use the
separate Funnel unit:

```sh
sudo install --mode 0644 /opt/fns-relay/systemd/fns-relay-funnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fns-relay-funnel.service
```

The unit starts `compose.funnel.yaml` and then runs `bin/funnel.sh start`.
That command uses a persistent Tailscale `--bg` configuration, TLS-terminated
TCP, and PROXY protocol v2. `bin/funnel.sh verify` records the local boundary
and `tailscale funnel status --json` under the evidence directory. It does not
prove public DNS or a working backend from an independent network; perform an
external anonymous-read smoke as well. Stop this endpoint with
`bin/funnel.sh stop`; do not use `tailscale funnel reset`, which can remove
unrelated Funnel configuration on the host.

Do not run `fns-relay.service` (the direct TLS profile) and
`fns-relay-funnel.service` against the same data paths. The Funnel profile
still requires application-level capability bearer authentication for
publication: Funnel grants no FNS publication authority.

### Deliberately limited non-root home beta

If a trusted home-server account has Docker access but cannot install a root
systemd unit, `home-funnel-beta-bootstrap.sh` initializes only a user-owned
runtime tree and builds a reviewed image. It generates two local Relay secrets
only when neither exists, makes them unreadable to the host user after setup,
and uses narrowly mounted Docker helpers to assign the service UID/GID. Set
`FNS_RELAY_HOME_BETA_ROOT` plus all durable paths below that root and explicitly
acknowledge the beta class:

```sh
export FNS_RELAY_HOME_BETA_CONFIRM=I_UNDERSTAND_HOME_FUNNEL_BETA_IS_NOT_SLO_COMPLIANT
bash /path/to/fns-v0/ops/host-relay/bin/home-funnel-beta-bootstrap.sh
docker compose --project-name fns-relay-funnel --env-file /path/to/relay.env \
  --file /path/to/fns-v0/ops/host-relay/compose.funnel.yaml up --detach
bash /path/to/fns-v0/ops/host-relay/bin/funnel.sh start
```

This path is suitable only for the public-beta endpoint. It is **not** allowed
to claim the stated RPO/RTO until root-managed archive timers, an independent
encrypted off-provider destination, restore drills, and alert delivery have
been configured and evidenced. Docker access itself is host-root-equivalent;
do not grant it to an untrusted account.

`target-host-funnel-smoke.sh` is the Linux/amd64 disposable test for this
profile. It validates the loopback-only port, PROXY v2 parsing, health/readiness
hiding, capability publication, anonymous pagination, graceful restart, and a
verified logical archive without altering Tailscale state. It complements,
rather than replaces, `target-host-smoke.sh`'s direct-TLS fresh-restore and
bad-permission coverage.

## Target-host smoke (explicitly non-production)

Run the following only after a real reviewed Relay image/build record and edge
image digest are present. It creates and removes a unique subtree under a
separate `FNS_RELAY_SMOKE_ROOT`; it refuses any path that overlaps configured
production data, secrets, archives, evidence, or drill directories.

```sh
set -a
. /etc/fns-relay/relay.env
set +a
export FNS_RELAY_SMOKE_ROOT=/srv/fns-relay-host-smoke
export FNS_RELAY_SMOKE_CONFIRM=I_UNDERSTAND_THIS_IS_NONPRODUCTION
sudo -E bash /opt/fns-relay/bin/target-host-smoke.sh
```

The smoke uses fresh capability and cursor secrets, a self-signed `.invalid`
certificate, unique Compose/container names, and loopback high ports. It does
not mount production paths or pass a token on a command line. It checks
non-root/read-only Relay configuration, internal health/readiness, edge-blocked
health/readiness, capability publication, anonymous cursor pagination,
SIGTERM/restart persistence, live verified archive, fresh restore/read, and a
clear failure for a root-owned non-writable candidate mount. It preserves a
root-only result JSON under `FNS_RELAY_SMOKE_ROOT/evidence` and removes only
that run's disposable data.

It does not prove public DNS propagation, CA-issued TLS, internet firewall
rules, monitoring delivery, or off-provider storage. Exercise those separately
with the selected domain, alert receiver, and recovery account. The normal
off-provider copy/restore drill remains the evidence for that boundary. CI runs
the same disposable profile on `linux/amd64`, but that does not replace this
target-host execution or its evidence.

`nginx/relay.conf.template` blocks public health/readiness paths, rate-limits
reads and publication separately, and deliberately does not log the request
URI, request body, or authorization header. It uses `$binary_remote_addr` as
the rate key; do not trust `X-Forwarded-For` until a trusted CDN/load-balancer
CIDR list is explicitly configured. Copy certificate material as real
`fullchain.pem` and `privkey.pem` files into `FNS_RELAY_TLS_DIR`; mounting only
LetsEncrypt's `live/` symlinks is insufficient. The supplied Nginx image runs
as UID/GID `101`; make those two files and their parent directory readable by
that group, while keeping them non-writable from the container. The edge has
only `NET_BIND_SERVICE` in addition to its non-root identity so it can bind
ports 80/443. Its root filesystem remains read-only: only `/run`, the
template output directory, and Nginx's cache directory are UID/GID `101`
tmpfs mounts.

## Backup, off-provider copy, and restore evidence

Install the units and timers from `systemd/` only after adapting their absolute
paths to the chosen host layout. They require `/etc/fns-relay/relay.env` and
the files under `/opt/fns-relay/bin/`.

```sh
sudo install --mode 0644 /opt/fns-relay/systemd/fns-relay*.service /etc/systemd/system/
sudo install --mode 0644 /opt/fns-relay/systemd/fns-relay*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fns-relay.service
sudo systemctl enable --now fns-relay-archive.timer fns-relay-off-provider.timer \
  fns-relay-restore-drill.timer fns-relay-slo-check.timer
```

Connect failures of each one-shot job as well as `fns-relay-slo-check.service`
to the chosen alert receiver; an age check alone does not provide immediate
notice of the first failed archive.

- `fns-relay-archive.timer` runs two minutes after boot and then 15 minutes
  after each archive job becomes inactive. The job has a 10-minute execution
  budget, so a capacity increase that cannot finish archive+verification in
  that time fails visibly instead of silently consuming the one-hour primary
  RPO margin. It exports and verifies a logical archive without network,
  capability DB, or secrets. A manifest appears last in
  `FNS_RELAY_VERIFIED_ARCHIVE_DIR`, which makes it the completion marker.
- `fns-relay-off-provider.timer` runs twice daily. `off-provider-copy.sh` uses
  `rclone` to copy only the latest verified archive, checksum, and manifest to
  the configured encrypted remote with immutable-destination semantics, then
  reads each artifact back and verifies SHA-256 before copying and verifying a
  named off-provider receipt. Another bucket or path on the same provider is
  not an off-provider copy.
- `fns-relay-restore-drill.timer` is weekly. It downloads the off-provider
  archive named by the latest successful off-provider-copy receipt, compares
  receipt/checksum/manifest/hash/source offer/Relay archive digest, restores
  into fresh drill directories with new non-production secrets/capability DB,
  rebuilds a temporary Relay image from the manifest's immutable public source
  offer and pinned Node image digest, starts an isolated loopback Relay,
  verifies readiness and an anonymous object read, and writes elapsed-time
  evidence. It never mounts production data or secrets.

Do not configure automated deletion until retention ownership, legal hold,
and recovery requirements have been approved. Daily off-provider copies prove
at most a 24-hour provider-loss RPO; claiming one hour requires independent
hourly copies.

For a recovery host that has no local evidence receipt, select the intended
remote artifact explicitly after reviewing its copied `receipts/` entry:

```sh
export FNS_RELAY_RESTORE_ARCHIVE_NAME=relay-YYYYMMDDTHHMMSSZ.json
sudo -E bash /opt/fns-relay/bin/restore-drill.sh
```

That path verifies the downloaded remote checksum, manifest, archive contract,
and recovered image metadata without reading a primary-host archive directory.

## What is still platform-owned

The repository can now provide the reference deployment automation, but an
actual public instance still needs a VM account/region, DNS control, TLS
certificate issuance, independent off-provider credentials, and an alert
receiver. The restore drill deliberately depends on the immutable public source
offer and pinned base-image registry being reachable; mirror those artifacts to
the independent recovery boundary if that dependency is unacceptable for the
four-hour RTO. Run the target-host smoke, real hourly archive, off-provider
copy, and isolated restore drill before declaring the public deployment
complete.
