# License map

This file records the repository's intended license boundary. A more-specific
directory notice takes precedence over the repository default. It does not
change the licenses of third-party dependencies, whose notices remain in their
own packages.

| Scope                                                                                                           | SPDX identifier                                                       | Notes                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository default: Core, Client, Standalone, Gateway, Builder, Store contracts, adapters, and conformance code | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html)                     | Applies to `src/`, `test/`, package/CI support, and other repository files unless listed below.                                                                                                                             |
| Relay contracts, adapters, and conformance                                                                      | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html)                     | Applies to `relay-v1/packages/relay-contract/**` and `relay-v1/packages/relay-local/**`; these remain reusable independently of the public Relay app.                                                                       |
| Public Relay application and its deployment/operation implementation                                            | [AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html) | Applies to `relay-v1/apps/public-relay/**`, `Dockerfile.relay`, `scripts/relay-container-smoke.js`, `.github/workflows/relay-container.yml`, and `ops/**`. It does not apply to the v0 library or Relay contracts/adapters. |
| Specifications, schemas, and test vectors                                                                       | [CC0-1.0](https://spdx.org/licenses/CC0-1.0.html)                     | Applies to `test-vectors/`, `specs/`, schemas, vectors, and the current normative planning/specification documents listed below.                                                                                            |

## Current CC0 specification material

- `STORE-INTERFACE-V0-PLAN.md`
- `STORE-INTERFACE-V0-FREEZE.md`
- `RELAY-V1-RFC.md`
- `test-vectors/**`

`README.md`, implementation documentation, CI files, and package metadata use
the repository default unless a later, more-specific notice says otherwise.

## License texts and publication follow-up

- [MPL-2.0](LICENSE) applies to the root package and reusable Relay packages.
- [AGPL-3.0-or-later](relay-v1/apps/public-relay/LICENSE) applies to the public
  Relay application.
- [CC0-1.0](specs/LICENSE) applies to specifications, schemas, and vectors.

The root package and the implemented Relay packages declare their SPDX license
identifiers in package metadata. This map intentionally does not invent a
copyright holder or a contributor agreement.
