<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Public Relay source offer

Every public Relay image is built with a required
`FNS_RELAY_SOURCE_OFFER_URL` build argument. It must be the immutable source
archive URL for the source that produced that image, for example:

```text
https://github.com/vuivahn/fns-v0/archive/<40-lowercase-hex-commit>.tar.gz
```

The image records this value in the root-owned
`/usr/share/doc/fns-relay/SOURCE-OFFER-URL` file and its OCI
`org.opencontainers.image.source` label. The public HTTP application makes it
available to network users at `GET /.well-known/fns-source`; a runtime
environment override that differs from the baked value fails startup.

The deployed image also contains:

- `/usr/share/licenses/fns-relay/AGPL-3.0-or-later.txt` - the full public
  application license;
- `/usr/share/licenses/fns-relay/MPL-2.0.txt` - the full license for the
  reusable Store and Relay packages;
- `/usr/share/doc/fns-relay/SOURCE-OFFER.md` - this record;
- `/usr/share/doc/fns-relay/SOURCE-OFFER-URL` - the immutable public archive
  URL; and
- `/usr/share/doc/fns-relay/Dockerfile.relay` - the production-image recipe.

The source offer identifies the public Relay application together with the
reusable MPL packages and root Store code it executes. It never includes
runtime databases, archives, bearer capabilities, peppers, cursor secrets,
operator accounts, or deployment credentials.
