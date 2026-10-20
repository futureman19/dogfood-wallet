# Source and local package installation

The package identity is **dogfood-wallet@0.1.0** and its bin is
**dogfood-wallet**, pointing at `src/cli.ts` (`#!/usr/bin/env bun`). It ships
TypeScript source, not compiled Node JavaScript. **Bun >=1.3.9** must be installed
and available on PATH for generated launchers; 1.3.9 is the tested baseline.
Node alone is not a supported runtime. npm is used to pack, not to run the CLI.
This is local package verification, not a claim of registry publication or name
ownership. Do not substitute `@dogfood/wallet` or an npm registry install command.

## Recommended source install

Clone the repository, run `bun install --frozen-lockfile`, then use
`bun --no-install /absolute/repo/src/cli.ts doctor`. Follow
[quickstart](quickstart.md) to explicitly select `DOGFOOD_WALLET_DIR` before init.
Source development and tests require the repository, including its lockfile and
fixtures; these are intentionally not bundled in the runtime package.

## Local tarball install (no global writes)

From the source repository, with Bun and npm available:

```sh
npm pack --ignore-scripts --pack-destination /absolute/artifacts
mkdir /absolute/consumer
cd /absolute/consumer
bun init -y
bun add --ignore-scripts /absolute/artifacts/dogfood-wallet-0.1.0.tgz
```

For a selected **disposable, never-funded** vault, run the installed entrypoint:

```sh
DOGFOOD_WALLET_DIR=/absolute/disposable/vault bun --no-install /absolute/consumer/node_modules/dogfood-wallet/src/cli.ts doctor
```

The package manager also creates a `node_modules/.bin/dogfood-wallet` launcher;
its platform-specific shim needs Bun on PATH. For MCP use the absolute Bun
executable, args `--no-install`, the absolute installed `src/cli.ts`, and `mcp`,
plus explicit `DOGFOOD_WALLET_DIR`. No client cwd support is assumed. Global
installation and native launchers outside Linux remain separate release gates.
The existing Ubuntu CI package check directly executes the local installed launcher
for help/doctor; it does not replace the launcher with `bun <bin-path>` on Linux.

## Reproducible acceptance

```sh
bun install --frozen-lockfile
bun run verify
bun run verify:package
```

The last command needs npm and registry access for a fresh local Bun consumer
install. It creates a real tarball and checks npm's JSON inventory against an
exact public allowlist, then installs into scratch with lifecycle scripts disabled.
Runtime processes use `--no-install`, scrubbed environment and an explicitly
selected unfunded vault, from unrelated cwd. For the native Linux launcher check,
a scratch-only `bunfig.toml` sets `install.auto = "disable"` and loads the fetch-denying
preload; a fresh marker verifies that preload ran for each help/doctor invocation.
Other platforms report explicit-Bun bin checks, not native-launcher acceptance.
It checks installed help/doctor,
local addresses, MCP discovery/address/status and deny-by-default; imports optional
runtime modules with fetch forbidden. It never calls balance, providers or chain
endpoints, funds anything, publishes, or uses global installs. All generated
vault material, tarballs and consumer files are deleted on success or failure.
Set TEMP/TMP/TMPDIR to private scratch on Windows before running.

Only production modules and reviewed public operating docs/license are shipped.
The owner-only deposit module `src/gryd-deposit.ts` and its operating contract
`docs/gryd-deposit.md` are included; the synthetic deposit fixture and tests are
source-development-only and are not runtime dependencies.
No production module needs repository test vectors or other bundled data; those
vectors are development fixtures. Tests, test-support, site, deployment files,
internal verification records, lockfile and dev scripts are excluded. The installed
runtime dependency graph resolves from the consumer, not repository node_modules.
The consumer resolves declared ranges anew; repository frozen install reproducibility
does not freeze a downstream consumer's transitive tree. Keep its generated lockfile.

Publication still requires registry/name/ownership decisions, dependency/license
and security review, OS/ACL/durability and recovery acceptance, and explicit release
authorization. No npm publishing or funded acceptance is implied by these checks.
