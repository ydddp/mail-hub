# Dependency preflight for R17

Source/registry/advisory preflight research, 2026-11-07. Baseline findings below predate the R17 changes recorded at the end. No exploit claim.

| Package | Baseline | Audit-safe floor | Selected patch target |
| --- | --- | --- | --- |
| hono | 4.13.5 | 4.13.11 | 4.13.16 |
| @hono/node-server | 1.19.17 | 2.1.3 | 2.1.6 |
| undici | 7.29.0 | 7.30.1 | 7.30.2 |
| ip-address | 10.5.0 | 10.7.4 | 10.7.6 |

The baseline production-dependency audit reported four affected packages, 3 moderate / 1 high, comprising 26 advisory records. This does not mean 26 exploitable entry points.

Actual calls: proxied HTTP uses package Undici fetch; direct HTTP and three Apple-auth calls use global fetch. Excessive content encodings ([GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)) and TLS 1.2 renegotiation ([GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)) have reachable preconditions through fetch. The other 16 Undici advisory APIs are unused here (WebSocket/EventSource, interceptors, SRI, BalancedPool, function-valued TLS options). In particular the decompression bomb advisory concerns `interceptors.decompress()`, which this application does not use.

Hono JSX and static middleware are unused; startup-loaded asset maps serve frontend assets. Node-server static middleware is also unused, but its newer raw-backslash request adapter notice affects the adapter actually used; exploitation additionally depends on reverse-proxy path restrictions. Version 1.19.18 lacks the double-decode guard present in 2.1.6. The documented v2 compatibility changes (Node 18 and Vercel adapter removal) do not affect the configured Node >=22 `serve({ fetch, hostname, port })` entry point. Runtime verification remains required.

`imapflow -> socks -> ip-address` constructs IPv6 addresses only after `net.isIPv6` or from a fixed 16-byte SOCKS reply. Vulnerable classifiers/subnet checks are unused. No vulnerable input path was demonstrated for its five advisory records.

Local Node 24.11.1 embeds Undici 7.16.0. Hanabi's shell Node 22.23.4 embeds 6.29.1 (corresponding fixes present). `/proc/<pid>/exe` verification found Mail Hub actually runs `/opt/node-dist/node-v24.22.1-linux-arm64/bin/node`, embedding Undici 7.30.1. The initial shell-only attribution to the production service was incorrect. Node 24.22.2 also embeds 7.30.1. Updating npm packages does not change embedded Undici.

Candidate Docker base verified in public OCI metadata for amd64 and arm64:
`node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8`.
Both stages should use the same tested digest. The current `npm ci || npm install` fallback masks lockfile failure; remove it during R17.

Local Docker CLI is installed, but its Linux engine is unavailable. A real isolated build/runtime check remains outstanding. No production runtime upgrade or deployment is authorized by this repair task.

The fixed official base was subsequently pulled and run on hanabi in a new container with no network, a read-only root filesystem and zero mounts. It reported Node 24.22.2, ABI 137, embedded Undici 7.30.1, linux/arm64. Verified index digest is the candidate above; arm64/v8 child is `sha256:1d9851811f111a340026bff10ecc075d51120788ef172c49337bf0f99e44a008`. Sanitized evidence: `.tmp/r17-base-runtime-68eb4f38-6848-4587-9ce3-16e7bed48004.json`, with protected remote evidence paths inside it. Container `mail-hub-r17-base-runtime-54e46f9f-e4e9-4609-9bf4-b85876b1187b` remains exited; no cleanup or production mounts were used. An initial diagnostic incorrectly compared Docker 29's OCI-index image ID to the platform config digest; its evidence remains, and descriptor/platform/runtime checks corrected that assumption. This verifies the base only; the upgraded application build and runtime smoke are still outstanding.

## R17 local dependency repair, 2026-11-08

Targeted npm operations selected exactly Hono 4.13.16, node-server 2.1.6, Undici 7.30.2 and transitive ip-address 10.7.6. The three direct semver lower bounds now match the selected targets; ip-address remains solely under `imapflow -> socks`, without a new direct dependency or override. The lockfile changed only these four dependency entries and matching root metadata. Package and lockfile release versions are consistently 0.11.12. Both Docker stages use the reviewed Node 24.22.2 digest above, and installation is only `RUN npm ci --omit=optional` with no fallback.

The same-class inventory was four affected dependency entries plus three Docker occurrences (two floating bases and one unlocked installation fallback), all repaired locally. `tests/lockfile.test.ts` now locks the reviewed advisory-safe floors for every installed lockfile copy through one table, manifest/lock consistency, and the Docker base/install contract. Floors permit later compatible patches; they are not exact-version snapshots. Existing version-response tests read the manifest, so no assertion was weakened or updated to a new hard-coded release number.

Evidence retained under `.tmp/`: `r17-audit-before-20261108.json` reports 4 affected packages (3 moderate / 1 high); fresh `r17-audit-after-20261108.json`, produced by `npm audit --omit=dev --json`, reports 0. The regression tests first failed on all four baseline versions and the Docker contract (`r17-lockfile-red-final.log`: 5 failed / 2 passed). After the changes, lockfile, HTTP retry, static asset, version and authentication tests passed 84/84 across five files (`r17-related-tests-freeze.log`), including the existing native-SQLite-backed local app fixtures. `tsc --noEmit` also passed (`r17-tsc.log`). The npm operation logs are `r17-targeted-install.log` and `r17-targeted-ip-address-update.log`; local installation skipped lifecycle scripts.

These checks do not verify a fresh native SQLite build or the node-server adapter in the upgraded container. The HTTP retry tests mock direct/proxy fetch, so real proxy/direct timeout, disconnect and permission checks remain assigned to the isolated Docker build/runtime verification. No full test suite, cleanup build script, Docker command, SSH command, production request or deployment was run for this local repair. Local Node remains 24.11.1 with embedded Undici 7.16.0; updating npm Undici does not replace global fetch. Only the separately verified base embeds Undici 7.30.1. The production service has not been upgraded by this change.

## Final frozen application image acceptance, 2026-11-08

The upgraded application was subsequently built and run on hanabi from frozen source `23243dfcc0c482f0f1fb58f4a36b5714f83d7333`. Strict `npm ci --omit=optional`, the actual `npm run build` and the final image all exited 0. The two-stage build used the pinned index digest above; the observed ARM64 base manifest was `sha256:1d9851811f111a340026bff10ecc075d51120788ef172c49337bf0f99e44a008`. Final inspected image ID: `sha256:6556fd1c69d8e4319d67b1b2813d75f06410832ff955eadaf87a32e5af97108a`.

The final image ran as UID/GID 1002:1002, with network `none`, a read-only root, dropped capabilities and no-new-privileges. Inspection proved exactly two binds: this run's new data directory and read-only smoke script, with no production mount. It reported Node 24.22.2, ABI 137, npm 11.19.1 and embedded Undici 7.30.1. All installed inspected packages matched the frozen lockfile: Hono 4.13.16, node-server 2.1.6, npm Undici 7.30.2, better-sqlite3 12.11.1 and ip-address 10.7.6.

All 14 real loopback checks passed: native SQLite; direct global-fetch and package-proxy success, HTTP error, timeout, disconnect and write-once behavior; HTTP authentication, body limits and raw-path authorization. These exercise the actual runtime/adapter/transport implementations inside the image, not live mail providers. The container exited 0 with no OOM or timeout kill. Source archive, image, exited container, isolated DB and logs were retained; no cleanup, production deployment or upstream mail operation occurred.

Sanitized local evidence: `.tmp/r17-final-fab631d8-1bcb-4d3a-b3c5-dd199a23e3a3/final-result.json`. Protected remote run: `/home/ydddp/mail-hub/data/verification/backend-repair-20261107/r17-final-fab631d8-1bcb-4d3a-b3c5-dd199a23e3a3`. This closes R17's isolated application-build/runtime acceptance; the production service remains on its existing source and runtime.
