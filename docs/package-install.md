# Package installation

The public package identity is **@dogfood/wallet@0.1.0** and its bin is
**dogfood-wallet**, pointing at `src/cli.ts` (`#!/usr/bin/env bun`). It ships
TypeScript source, not compiled Node JavaScript. **Bun >=1.3.9** must be installed
and available on PATH for generated launchers; 1.3.9 is the tested baseline.
Node alone is not a supported runtime. npm installs the package; Bun runs the CLI.

## Registry install (primary path)

After the human-gated first registry release:

```sh
npm i -g @dogfood/wallet
dogfood-wallet --help
DOGFOOD_WALLET_DIR=/absolute/disposable/vault dogfood-wallet doctor
```

Follow [quickstart](quickstart.md) to select an explicit vault before `init`.
Do not fund disposable rehearsal vaults. Registry availability and global native
launcher acceptance are not established by local package checks. The quickstart
uses source commands; with the package installed, replace `bun src/cli.ts` with
`dogfood-wallet`.

## Source development

Clone the repository, run `bun install --frozen-lockfile`, then use
`bun --no-install /absolute/repo/src/cli.ts doctor`. Follow
[quickstart](quickstart.md) to explicitly select `DOGFOOD_WALLET_DIR` before init.
Source development and tests require the repository, including its lockfile and
fixtures; these are intentionally not bundled in the runtime package.

## Offline tarball fallback (no global writes)

Transfer a previously built tarball when registry package installation is unavailable.
A fully offline install also needs dependencies already cached or transferred; the
tarball does not vendor them.

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
DOGFOOD_WALLET_DIR=/absolute/disposable/vault bun --no-install /absolute/consumer/node_modules/@dogfood/wallet/src/cli.ts doctor
```

The package manager also creates a `node_modules/.bin/dogfood-wallet` launcher;
its platform-specific shim needs Bun on PATH. For MCP use the absolute Bun
executable, args `--no-install`, the absolute installed `src/cli.ts`, and `mcp`,
plus explicit `DOGFOOD_WALLET_DIR`. For global npm installs, locate the package
under `npm root -g` plus `/@dogfood/wallet/src/cli.ts`. No client cwd support is assumed. Global
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

## Human-gated release and provenance

`.github/workflows/publish.yml` runs only for pushed `v*` tags, checks the tag
against the package version, installs with the frozen Bun lockfile, runs both
verification gates and publishes with provenance and public access. Releases are
serialized without cancelling an in-flight publish. npm also runs the same gates
through `prepublishOnly` on ordinary manual publication; do not bypass lifecycle
scripts for publishing. The workflow uses GitHub-hosted Ubuntu, Bun 1.3.9 and an
OIDC-capable Node/npm toolchain. No npm token secret is used.

After review and merge/push by Kimi, the human release owner must:

1. Create the free `dogfood` organization on npmjs.com for public packages.
2. Enable two-factor authentication on the npm account.
3. Configure the Trusted Publisher for `@dogfood/wallet`: GitHub repository
   `futureman19/dogfood-wallet`, workflow filename `publish.yml`, and allow direct
   publishing. The `v*` tag restriction is enforced by the GitHub workflow; do not
   assume npm offers a tag-pattern field.
4. Only after registry setup is ready, Kimi creates and pushes `v0.1.0` for the
   first CI publication with provenance. Never reuse an already published version.

**First-publication prerequisite:** npm's [trust documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
requires the package to exist before configuring a trusted publisher. For this
unpublished name, the owner must confirm npm's supported bootstrap path before
creating the release tag. If a human bootstrap publication consumes `0.1.0`, stop:
the subsequent CI release needs a separately reviewed version bump, not a retry
of `v0.1.0`. This slice does not create the organization, configure registry trust,
bootstrap publication, create tags or publish anything. See the current
[Trusted Publishing requirements](https://docs.npmjs.com/trusted-publishers/) before
release; newly configured trust may expire if not validated promptly.

Dependency/license and security review, OS/ACL/durability and recovery acceptance,
and explicit release authorization remain human gates. Local green checks do not
prove registry authentication, provenance issuance or funded acceptance.
