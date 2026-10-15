# Local toolchain and release verification

This is a bounded local verification record, **not a security audit, launch
approval, live bridge proof, or npm publication**. Baseline: clean `main` at
`5e21c207e3c8f714cc0dc571755c7cd61e4cb255` (matching the local `origin/main`).

## Repeatable checks

From the root:

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs `tsc --noEmit -p tsconfig.json` followed by the full `bun test`.
The existing strict configuration still includes **all `src/**/*.ts`**, including
bridge, allowance, payment guard, CLI, MCP, merchant code, tests and subprocess
fixtures. No production paths or tests were excluded. Existing `skipLibCheck`
was retained; this checks project source, not all dependency declarations.
There is no root build script: the CLI and merchant run TypeScript directly in Bun.

The independent JavaScript/React site has its own manifest and lockfile, outside
root TypeScript scope:

```bash
cd site
bun install --frozen-lockfile
bun test
bun run build
```

Root `bun test` currently discovers the site's tests too; the site command also
checks them with its own installed dependency tree. CI now uses Bun **1.3.9**,
frozen installs, root `verify`, and the separate site tests/build in the existing
workflow. Hosted CI execution remains to be observed after review/push.

On Windows, direct disposable test files to a private scratch location by setting
**TEMP, TMP and TMPDIR** before running tests; `os.tmpdir()` may prefer TEMP/TMP.
The recorded run used the active agent profile's scratch, never operational vaults.

## Toolchain repair

Exact root development dependencies:

- `typescript@5.9.3`: explicit stable compiler compatible with the SDKs' TypeScript
  peer ranges, instead of relying on an undeclared auto-installed peer compiler.
- `bun-types@1.3.9`: matches the exercised Bun runtime and existing tsconfig entry.
- `@types/node@22.20.5`: explicit modern Node-compatible built-in declarations.
  The previous transitive Node 12 types did not supply the `node:*` declarations
  needed by the source; Bun types alone did not fix checking.

Only compiler/type packages changed resolution. Runtime package versions are
unchanged. The lock replaces the previously implicit TypeScript 7.0.2 peer and
its native platform packages, adds Bun/Undici types, and preserves older transitive
Node type resolutions where the lock already used them. The site lock is unchanged.

After installing these declarations, the compiler exposed **95 diagnostics**.
Corrections cover SDK mutable protocol tuples; optional/discriminated test values;
fixture literal types; structurally complete offline fetch doubles (including a
fail-fast `preconnect`, with no real networking); settlement receipt type aliases
instead of flow-narrowed `typeof settle`; CLI facilitator callback types; typed
EVM nonce construction; and Bun's TCP-only server port invariant. No blanket
`any`, `ts-ignore`, disabled checking, or weakened runtime assertions were added.

One genuine runtime correction was required: Solana signature counts live at
`message.header.numRequiredSignatures`, not directly on `message`. A serialized
transaction with a transfer authority removed from the signer header first failed
the new regression (it reached the later missing-signature check), then passed
with the corrected signer check. The test asserts rejection before any RPC;
existing valid signed payment tests still pass. This does not demonstrate a
previously successful payment exploit or constitute a Solana security audit.

## Actual local results

Environment: Windows, Bun 1.3.9; site Vite 7.3.7 from its existing lock.

| Command | Result |
| --- | --- |
| Root `bun install --frozen-lockfile` | Passed, no lock changes |
| Fresh scratch copy, no node_modules: frozen install + `bun run typecheck` | Passed; 175 packages installed, then zero TypeScript diagnostics |
| Root `bun run typecheck` | Passed, zero diagnostics |
| Solana regression file, before correction | 10 passed / 1 expected failure |
| Solana regression file, after correction | 11 passed / 0 failed |
| Root `bun run verify` | Passed; 540 tests / 41 files / 2,080 assertions / 0 failures |
| Site frozen install | Passed, no changes |
| Site `bun test` | 8 tests / 2 files / 22 assertions / 0 failures |
| Site `bun run build` | Passed; 1,867 modules transformed |
| `git diff --check` | Passed |
| `npm pack --dry-run --ignore-scripts --json` | Local inventory succeeded; nothing published |

Site build output: `index-DpwuaTb_.css` (27.96 kB) and
`index-CdnnRYou.js` (368.12 kB); generated `dist/` is ignored. No browser visual
acceptance, Docker build, deploy, live provider/chain calls, balances, funding,
or real payments were performed in this pass. Test settlement is synthetic or
intercepted, with disposable unfunded vaults and loopback servers.

## Packaging and remaining release decisions

- Supported install docs say **clone + Bun + frozen install**, not npm global
  install. The current site links to those instructions. Manifest identity is
  `dogfood-wallet@0.1.0`, not `@dogfood/wallet`; its executable points to
  `src/cli.ts` with `#!/usr/bin/env bun`. This is not a Node-only executable.
  Registry ownership/publication status and global-install behavior were not
  verified. Nothing was published.
- No package `files` allowlist or `.npmignore` exists. The local dry run includes
  source tests/test-support, site assets, CI and deployment files. Define/review
  an intentional distribution inventory before publishing; then test an actual
  packed install on supported platforms without operational keys.
- There is no `repository` metadata, publishing configuration, or release lifecycle
  gate in the manifest. Decide those explicitly rather than treating successful
  source verification as publication approval.
- `@noble/curves/ed25519` is imported directly by production Solana merchant code
  but currently supplied transitively. Fresh Bun installation/checking works;
  review direct runtime dependency declarations before promising portable package
  installation. This pass did not broaden runtime dependency changes.
- The manifest still declares Bun `>=1.1.0`; only **1.3.9** was exercised here.
  Validate the advertised minimum (including text-lockfile support), or revise it
  deliberately. Docker still uses floating `oven/bun:1`; image reproducibility and
  container execution were not tested. Node type declarations do not imply Node
  runtime support.
- Security review, dependency/advisory/license review, supported-OS/ACL and
  power-loss durability, backup/recovery drills, actual agent-client UI acceptance,
  and carefully authorized funded acceptance remain separate gates. Existing
  `any`/assertions elsewhere are not claimed eliminated by this typecheck pass.
- Bridge provider schema fixtures remain synthetic. Live pair availability and
  order/receipt compatibility are unverified; the centralized provider still
  supplies deposit-to-payout attribution. Review [bridge limitations](bridge-lifecycle.md),
  [provider provenance](bridge-provider-contracts.md), and
  [payment recovery](payment-recovery.md), including excluded spend paths,
  ambiguous exposure holds and exactly-once accounting, before unattended use.
