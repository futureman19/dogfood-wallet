# First run: BSV, one local vault, no payment required

Start with BSV only. USDC, bridges, merchants and delegation are optional;
none is needed to initialize a vault or connect an agent. This is mainnet
software, not a testnet faucet. Completing this guide does **not** pay anyone.

## 1. Install from source

Install Git and [Bun](https://bun.sh/docs/installation) first, then open a new
terminal. These commands are for bash (including Windows Git Bash), not PowerShell:

```bash
git --version
bun --version
git clone https://github.com/futureman19/dogfood-wallet
cd dogfood-wallet
bun install --frozen-lockfile
```

`package.json` declares Bun >=1.1.0; the walkthrough was exercised with Bun
1.3.9 on Windows. No published npm package is required. If Bun is missing,
install it before running diagnostics. If dependency imports fail, use
`bun src/doctor.ts` (built-ins only), then rerun `bun install --frozen-lockfile`.

## 2. Select an isolated vault BEFORE initializing

For a disposable, **never-funded** rehearsal, create a unique directory outside
the repository and export its absolute path:

```bash
export DOGFOOD_WALLET_DIR="$(bun -e 'const fs=require("node:fs"),os=require("node:os"),p=require("node:path"); console.log(fs.mkdtempSync(p.join(os.tmpdir(),"dogfood-first-run-")))')"
bun src/doctor.ts
bun src/cli.ts init
bun src/cli.ts doctor
bun src/cli.ts address
bun src/cli.ts status
```

The first doctor reports `vault: missing`, `policy.state: missing`, no hold.
After init it reports `files-present-unverified`, `allowlist: deny-all`, zero
destinations, 10,000 sats/tx and 50,000 sats/day. `status` shows zero recorded
usage, **not** proof of zero on-chain balance. Re-running init refuses overwrite.

For a real wallet, **instead of a temporary directory**, explicitly select a
new persistent private directory outside the clone (example Windows bash):

```bash
export DOGFOOD_WALLET_DIR='C:/Users/YOUR_USER/PrivateWallets/dogfood-bsv'
# Check the path in output before initializing a NEW wallet:
bun src/doctor.ts
```

Replace `YOUR_USER`; on macOS/Linux use an absolute path such as
`/home/YOUR_USER/PrivateWallets/dogfood-bsv`. Only run `init` when this is the
new vault you intend to create. To use an existing vault, select its directory
and run doctor/address, **not init**. Export the same path in every new terminal
and explicitly pass it to the agent process. An unset/blank variable selects
`~/.dogfood-wallet`; changing cwd does not select a wallet.

**Never fund the temporary rehearsal vault.** Temporary directories may be
cleaned automatically. Keep real vault files private and securely backed up
before funding; the wrapping key is stored beside the encrypted key, so copying
both gives access. Do not put vaults in Git, public cloud shares, logs or agent
context. Local filesystem access by the agent is outside the MCP policy boundary.

## 3. Human policy and funding decisions

Default BSV policy is deliberately deny-by-default. An empty allowlist is not an
installation failure. For a rehearsal, allow only the generated unfunded vault's
own public address:

```bash
REHEARSAL_ADDRESS="$(bun src/cli.ts address)"
bun src/cli.ts allow "$REHEARSAL_ADDRESS"
bun src/cli.ts doctor
bun src/cli.ts status
```

Doctor now shows `restricted`, one destination. In a real vault, the human must
independently verify the intended merchant's **BSV mainnet P2PKH** address and
run `bun src/cli.ts allow 'VERIFIED_MERCHANT_ADDRESS'` instead. Do not paste the
placeholder. `allow` is BSV-only; it is not a universal per-chain allow command.
It authorizes a destination, not a payment, and is not exposed through MCP.
Only the top-level BSV `allowlist` is changed; caps, `evm`, `solana`, `bridge`
and unknown extension fields are preserved. Adding an existing destination is
an unchanged-file no-op. A legacy omitted/null `allowlist` is unrestricted on
load; running `allow` intentionally replaces that with a restricted list
containing the requested destination (the existing command semantics).

Human-edit `policy.json` only with agents stopped if you need different caps.
Keep `allowlist` explicit; omitted/null means legacy **unrestricted** behavior.
A missing file retains legacy load defaults, but `allow` refuses to recreate it.
Malformed JSON and null/array/primitive policy roots fail closed on load and
allow. An unreadable file is not replaced; `allow` also refuses malformed BSV
allowlist values and duplicate top-level allowlist keys instead of normalizing
them. Doctor flags missing/invalid policy but does not repair it.
`allow` writes a flushed sibling temporary file and renames it over the policy;
this avoids exposing a partial write, but is **not a concurrent-editor lock**.
Stop spenders and other policy writers before editing or running `allow`;
concurrent edits can still be lost. No directory-fsync or Windows power-loss
guarantee is claimed.
BSV caps are satoshis, not dollars; daily accounting uses UTC. A `null` lifetime
cap means none. Doctor summarizes BSV policy only and does not validate BRC-181
signatures or USDC policy blocks.

For a persistent real vault, `address` prints the receiving address. Confirm the
selected path and address, then manually send a small BSV amount from a wallet
you control; allow fee headroom. Do not send BTC/BCH or USDC to this address.
Funding does not require allowlisting the incoming sender. No funding is needed
for the connection checks below. `bun src/cli.ts balance` is an **optional online**
WoC balance query, deliberately not part of the offline rehearsal. `address` and
`status` are offline but load/decrypt the local key; doctor/payment-inspect do not.

## 4. Connect one agent (choose stdio OR HTTP)

Keep the rehearsal vault unfunded. Connecting exposes payment tools as well as
reads: require human approval in your client and first request **only address
and status**. Compare the returned address with the CLI. Do not ask it to test a
payment. Discovery alone is not a successful real payment or full client QA.

### Stdio: local process launched by the client

Get absolute paths for your configuration:

```bash
bun -e 'console.log(process.execPath); console.log(require("node:path").resolve("src/cli.ts")); console.log(process.env.DOGFOOD_WALLET_DIR)'
```

Claude Desktop's `mcpServers` / `command` / `args` structure is described in the
[official local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
Merge an entry into its config via Settings > Developer > Edit Config; do not
replace unrelated entries. Example Windows paths below are **placeholders**:

```json
{
  "mcpServers": {
    "dogfood-wallet": {
      "command": "C:/Users/YOUR_USER/.bun/bin/bun.exe",
      "args": ["C:/Users/YOUR_USER/dogfood-wallet/src/cli.ts", "mcp"],
      "env": {
        "DOGFOOD_WALLET_DIR": "C:/absolute/path/to/your/selected/vault"
      }
    }
  }
}
```

Use the actual Bun executable, CLI and vault paths printed above. On Unix use
absolute `/...` paths. Use forward slashes or escaped backslashes in JSON.
No `cwd` support is assumed; no relative script paths, `~` expansion, shell
variables, or inherited terminal environment are needed. Other clients may use
a different configuration schema: supply the same command, arguments and
environment using their documented settings, not this JSON blindly. Restart the
client after saving. Do not manually run `mcp` and type into its stdout stream;
it is JSON-RPC, not an interactive prompt.

### HTTP: signer stays on this machine

In a terminal with the same explicitly selected vault:

```bash
DOGFOOD_MCP_HOST=127.0.0.1 DOGFOOD_MCP_PORT=38402 bun src/cli.ts mcp-http
```

Leave it running. In another terminal:

```bash
curl http://127.0.0.1:38402/health
```

Expected `{"ok":true,"name":"dogfood-wallet"}`. Configure a client that supports
**Streamable HTTP** with URL `http://127.0.0.1:38402/mcp`, not `/health`, not a
legacy SSE-only connection. It uses stateless POST; GET `/mcp` returning 405 is
expected. Client UI/config fields differ. Stop this server with Ctrl-C when done.

Loopback is not authentication against other local processes. If
`DOGFOOD_MCP_TOKEN` is set, configure the client to send it as a Bearer token
in the Authorization header. Non-loopback binding requires that token; do not expose this signing service to
the internet for onboarding. Keep token values out of prompts/logs. A remote
cloud client cannot reach your machine's loopback without separately secured
connectivity; no tunnel or deployment is part of this guide.

Both transports expose `address`, `balance`, `status`, `send`, `kill`,
`x402_inspect`, `x402_proof`, `x402_delegate`, `x402_pay`. Neither exposes `allow`,
`sweep`, doctor or hold clearing. The automated rehearsal checks SDK discovery
and address on both transports using absolute paths and an unrelated cwd.
Actual Claude Desktop/other client UI setup remains a manual check.

## 5. Pause and inspect; do not reset a hold

```bash
bun src/cli.ts kill
bun src/cli.ts doctor
bun src/cli.ts payment-inspect
```

After kill, doctor reports `kill: present`. With no payment attempted,
payment-inspect returns `blocked: false`, `lock: absent`, `pending: absent`.
Kill and payment holds are separate: a false hold does **not** override kill,
policy, insufficient funds or any other gate. `kill` does not cancel already
signed/forwarded authorizations. Leave the rehearsal frozen.

Doctor and payment-inspect are read-only/offline; no unlock, key decryption,
balance request or setting changes. Doctor exits zero when it can print a report,
**even if blocked or incomplete**. It is not an authorization/readiness verdict.
It checks installed package metadata under the clone's `node_modules`, not
runtime compatibility. BRC-181 is presence-only; private file presence does not
prove keys are intact. Use standalone `bun src/doctor.ts` when dependencies are
missing (the normal CLI imports dependencies before command dispatch).

If `hold.blocked` is true, stop all spenders and follow
[payment recovery](payment-recovery.md). Preserve evidence; independently
reconcile settlement and exactly-once accounting before any human release.
Do not delete `payment.lock`, `payment.pending.json` or `STOP_SPENDING` as a
first-run fix, retry payment, or create a replacement wallet to bypass a hold.
There is no automated recovery/clear tool. Sweep/bridge/allowance paths
are not all covered by the guard; do not use them to bypass a hold. Windows
power-loss durability and scope limitations are detailed in the recovery guide.

## Optional later tracks — not prerequisites

- **Base or Solana USDC:** separate derived receiving addresses (`evm-address`,
  `sol-address`), separate network/token funding, and explicit human-configured
  `evm.usdc` / `solana.usdc` blocks in `policy.json`. Disabled by default. Do not
  fund a chain merely because an address can be derived. Review the README's
  x402 rail notes first. BSV `allow` preserves these optional blocks but does
  not authorize USDC destinations or enable a pocket. Configure/review each
  chain's policy separately with agents stopped. This guide does not exercise
  USDC funding.
- **Merkle Works delegation:** set a trusted `DOGFOOD_X402_DELEGATOR_URL` only
  when you actually need that separate protocol. It is not an MCP endpoint.
  Funded delegation is deliberately restricted to one UTXO, positive change and
  an input-appending sponsor; no general delegator compatibility is claimed.
  Signed client funding can remain exposed even with broadcast off and retain
  a hold. See README and recovery guidance before attempting it.
- **BRC-181, allowances, bridge, merchant hosting:** advanced independent setup,
  not part of first run. No live settlement is claimed by these diagnostics.

See [verification evidence](onboarding-verification.md) for the exercised scope.
