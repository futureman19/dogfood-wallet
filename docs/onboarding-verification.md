# First-run verification evidence

Scope: bounded local onboarding on Windows/Git Bash, Bun 1.3.9; starting commit
`ee627ebdc8bd30c515ed958a42033bb08e155227`. Only generated, unfunded disposable
vaults under the active profile scratch directory were used. No real vault,
treasury, chain balance query, provider payment, key output, deployment or
running agent configuration was involved. Package installation and official MCP
documentation retrieval are separate from the offline wallet checks.

## Fresh source installation

A disposable local Git clone of the starting commit was made with
`git clone --no-hardlinks C:/Users/futur/Desktop/dogfood-wallet <scratch-clone>`.
Inside it, `bun install --frozen-lockfile` exited zero and installed 173 packages:
`@bsv/sdk@3.1.0`, MCP SDK 1.32.1, spl-token 0.4.15, web3.js 1.99.0, viem 2.57.4.
With `DOGFOOD_WALLET_DIR=<scratch-clone>/fixture-vault`, actual CLI `init` and
`status` exited zero: 10,000 sats/tx, 50,000/day, empty allowlist, zero recorded
usage, kill off. Clone and fixture were removed afterward. Remote GitHub clone
access and first-time Bun installation were not tested; installation used the
existing Bun binary. The clone tested baseline install; new diagnostics were
then exercised from the working tree.

## Quickstart commands exercised

The exact bash temporary-directory expression in `quickstart.md` was run, then:

```bash
bun src/doctor.ts
bun src/cli.ts init
bun src/cli.ts doctor
bun src/cli.ts address
bun src/cli.ts status
REHEARSAL_ADDRESS="$(bun src/cli.ts address)"
bun src/cli.ts allow "$REHEARSAL_ADDRESS"
bun src/cli.ts doctor
bun src/cli.ts status
bun -e 'console.log(process.execPath); console.log(require("node:path").resolve("src/cli.ts")); console.log(process.env.DOGFOOD_WALLET_DIR)'
bun src/cli.ts kill
bun src/cli.ts doctor
bun src/cli.ts payment-inspect
```

All exited zero. Observed transitions:

| Step | Actual result |
|---|---|
| Before init | missing vault/policy, installed dependency metadata, no hold |
| After init | files-present-unverified, deny-all, 0 destinations, default caps |
| After human self-address allow | restricted, 1 destination; same CLI address |
| After kill | kill present; no pending/lock; inspection blocked=false |

The generated address was never funded. The rehearsal directory was removed
only after completing all checks; this cleanup is not a real-vault recovery step.

## Automated regression checks

Doctor tests were written first: **0 pass / 5 fail** before implementation
(unknown CLI command / absent standalone module). Final focused results:

- `bun test src/doctor.test.ts`: **5 pass, 0 fail**, 28 assertions.
  Missing vault is not created; deny-all and allowed policy summarized; corrupted
  private file sentinels do not prevent diagnostics and are not printed; no
  file name/size/mtime changes; kill and corrupt hold preserved; malformed and
  legacy unrestricted policy distinguished; standalone script works without
  installed package dependencies.
- `bun test src/onboarding.test.ts`: **1 pass, 0 fail**, 23 assertions.
  Actual CLI init/address/status/allow/kill/doctor/payment-inspect processes;
  actual stdio MCP and CLI HTTP server, SDK initialize/tools-list/address;
  HTTP health over loopback. Absolute Bun/script/vault paths and unrelated cwd.
  Both transports returned the same generated vault address and exactly the
  documented nine tools. No allow/sweep/clear tool. A fixture-only orphan lock
  reported `blocked=true, lock=present, pending=absent`; no payment occurred.
  Server processes and fixture directories are cleaned up in `finally`.

Tests on this Windows host explicitly used:

```bash
export TEMP='C:/Users/futur/.hermes/profiles/telegram2/cache/scratch'
export TMP="$TEMP" TMPDIR="$TEMP"
bun test
git diff --check
```

Full result: **355 pass, 0 fail, 1,363 assertions, 33 files**. `git diff --check`
exited zero. Existing payment tests use their fixture/intercepted-network paths;
these are not live settlement evidence.

## Friction addressed / boundaries retained

- Old install path initialized the default vault immediately. New guide selects
  an explicit isolated path before initialization and distinguishes rehearsal
  from persistent funding.
- Old MCP snippet depended on relative script + undocumented client `cwd`.
  Absolute executable/script plus explicit vault environment replace that.
  Official MCP local-server documentation was checked for Claude Desktop's
  `mcpServers`/`command`/`args` structure. SDK transport discovery was executed;
  no installed desktop client UI was configured or claimed tested.
- Existing `status` decrypts keys. The new doctor only reads public policy and
  sanitized hold metadata, stats key filenames, and checks installed dependency
  metadata. It does not import/resolve third-party packages (Bun resolution can
  auto-install), decrypt, authorize, mutate or fetch. Standalone mode remains
  available before dependencies are installed; normal CLI imports still need
  dependencies. Exit zero means report generated, not safe-to-spend.
- Current BSV `allow` can drop optional policy blocks. This is documented, not
  redesigned here. Missing/malformed/legacy policy handling in the signer is
  likewise unchanged; diagnostics must not be mistaken for enforcement.
- Manual gates remain: secure persistent storage/backup and OS permissions,
  human merchant verification/policy review, funding, online balance/settlement,
  actual chosen-client setup/approvals and any forensic hold reconciliation.
  No USDC/delegation live compatibility, remote HTTP connectivity, Linux/macOS
  execution or Windows power-loss guarantee is implied.
