# Relay v1 license boundary

| Path                         | SPDX identifier                                                       |
| ---------------------------- | --------------------------------------------------------------------- |
| `packages/relay-contract/**` | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html)                     |
| `packages/relay-local/**`    | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html)                     |
| `apps/public-relay/**`       | [AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html) |
| `../specs/relay-v1/**`       | [CC0-1.0](https://spdx.org/licenses/CC0-1.0.html)                     |

The public Relay application is intentionally separate from FNS identity,
trust, and authority. Adding an alternative authentication or storage adapter
does not by itself turn that adapter into AGPL-covered application code.
