# Dogfood Wallet

The zero-trust wallet for agentic commerce. The LLM requests payment; a signer on **your** machine authorizes it. The model never sees the key.

One vault secret speaks three chains — BSV, USDC on Base, USDC on Solana — and pays HTTP 402 challenges in seconds for a fraction of a cent. A merchant server is included, so the same codebase that buys is the codebase that sells.

Open source (MIT). Not a hosted wallet. Not a consumer portfolio app. No revenue machinery, ever — if you charge with it, that money is yours.

**Live demo register:** [`dogfood-merchant.fly.dev/v1/fortune`](https://dogfood-merchant.fly.dev/v1/fortune) — call it with no credentials, get a 402 price menu.

**Receipts (every claim is auditable):**

- BSV mainnet — [500-sat 402 payment, ~$0.00004 fee](https://whatsonchain.com/tx/5e0dacad4106833a3e1cc78778dd77e1951b3c410d79080c438a031c5298119c)
- USDC on Base mainnet — [$0.001 settled by the wallet's own facilitator](https://basescan.org/tx/0xb5f3cb4356f37474dd5e3e80585c39d23958e1c03e706732b4eee8d76e9c43de)
- USDC on Solana devnet — [fee-payer co-signed, payer needs no SOL](https://solscan.io/tx/25Ung41rJSNDtNVFuLLrsmZDnd3Lqf53vmENniQ3Eavf4PSCkWnJSRovP1Twy6ZGDpn6tLbX4YPCxVp9v7wACQpd?cluster=devnet)

## Architecture

1. **Brain (agent)** — knows what to buy. Talks to the vault over MCP or CLI.
2. **Vault (this repo)** — keys, per-asset caps, allowlists, killfile, structured rejects. One 32-byte secret derives all three identities (BSV P2PKH, secp256k1 EVM, ed25519 Solana).
3. **Settlement** — whatever rail the merchant offers: BSV direct, or USDC via x402 `exact` on Base / Solana. Tiny fees make per-call payments real.

There is no `refund` tool. Sweep/recovery is the owner's job, not the agent's.

## Install

**New here? Start with the [BSV-first quickstart](docs/quickstart.md): isolated vault selection, deny-by-default policy, agent connection and offline recovery diagnostics. No funding or payment is needed for the rehearsal.**

Needs [Bun](https://bun.sh) **>=1.3.9** (tested baseline: 1.3.9). This is a
TypeScript/Bun CLI, not a Node executable. The package/bin name is `dogfood-wallet`;
no registry publication is claimed. See [local tarball installation and package
verification](docs/package-install.md) for the supported non-global package path.

```bash
git clone https://github.com/futureman19/dogfood-wallet
cd dogfood-wallet
bun install --frozen-lockfile
# Next: follow the quickstart to select an isolated vault before init/doctor.
```

The default vault is `~/.dogfood-wallet`; override with an absolute `DOGFOOD_WALLET_DIR` to avoid selecting the wrong vault. New vaults: **10,000 sats/tx**, **50,000 sats/day**, **empty allowlist** (a human must `allow` a BSV destination before the agent can send). EVM and Solana are optional tracks, not prerequisites. Never fund a disposable rehearsal vault.

```bash
bun src/cli.ts address                 # BSV
bun src/cli.ts evm-address             # Base/EVM
bun src/cli.ts sol-address             # Solana
bun src/cli.ts balance                 # plus evm-balance / sol-balance
bun src/cli.ts status
bun src/cli.ts doctor                 # offline metadata, no key decryption
bun src/cli.ts allow <address>         # BSV P2PKH only; human-only
bun src/cli.ts send <p2pkh-address> <sats> [--max-fee <sats>] [--] [note]
bun src/cli.ts fund-request <sats>
# or paste that address into the Yours button on https://dogfoodwallet.com
bun src/cli.ts kill                    # writes STOP_SPENDING
bun src/cli.ts sweep <p2pkh-address>
bun src/cli.ts split [piece-sats]
```

`allow`, `sweep`, `split`, and `fund-request` are **human-only** — not MCP tools. Sweep bypasses caps, allowlist, and killfile so the owner can take funds back. Split turns one fat UTXO into up to 20 even self-outputs so later agent sends are not serialized on a single coin. Split does **not** count against daily/lifetime caps. A **human** deletes `STOP_SPENDING` to resume agent sends. Agents must not.

## Gryd agent envelopes (Phase 1: offline, human-supervised)

```bash
# Select an existing, disposable UNFUNDED vault explicitly for rehearsal.
DOGFOOD_WALLET_DIR=/absolute/path/to/disposable-vault \
  bun src/cli.ts agent-call agent.mine POST /api/v1/agents/mine '{}'
```

`agent-call <agent.action> <POST|PUT|DELETE> <exact-path> '<body-json>'`
prints `{ payload, signature, pubkey, address }` JSON. It does **not** call Gryd,
broadcast a transaction, move funds, install permissions, or expose an MCP tool.
Human-supervised means an owner invokes this CLI deliberately; there is no
interactive confirmation or autonomous authorization policy in Phase 1.

Any `agent.*` action in the mirrored protocol `SignedWriteAction` union is
supported with an arbitrary JSON object body. Unknown/non-agent actions are
rejected. Supply the exact encoded route path and uppercase method: these are
signed, never normalized. Bodies must be plain JSON (no undefined, non-finite
numbers, custom objects or cycles). A fresh UUID and Unix-seconds timestamp are
generated per call; the network field is omitted as in the web client.

The signature is compact base64 Bitcoin Signed Message using the vault identity
key, over `Locus Signed Write\n` plus recursively key-sorted JSON. Keys never
appear in output. `STOP_SPENDING` blocks vault signing; local payment caps and
BRC-181 spend accounting are **not** an authorization policy for Gryd actions.
Treat printed envelopes as sensitive, usable authorizations: manually submitting
one later could authorize remote mutations, including financial actions. Do not
submit one as part of this offline rehearsal. The backend checks freshness (the
protocol specifies a 300-second skew window), ownership and route/action rules;
this slice does not prove live backend acceptance or autonomous transactions.

Library: `src/gryd-agent.ts` exports `signAgentRequest(action, body, { method,
path }, key, options?)` for explicit keys, and `signVaultAgentRequest(root,
action, body, { method, path })` for the guarded vault boundary. The pure-key
helper does not inspect a vault or its killfile. Timestamp/nonce/network options
on the pure helper support deterministic testing; the CLI offers no overrides.

Frozen canonicalization vectors were executed from
`packages/locus-protocol/src/signed-write.ts` in Gryd checkout
`211194c3ab177cefb2b359e27a5ceeaad4c012bf`; the fixture records its source SHA-256.
They cover nested key sorting (including numeric-looking keys), arrays, Unicode,
escaping, numeric formatting, encoded paths, all three methods, and optional
network. Signatures use public synthetic scalar 1, **not a vault key**.
Regenerate deliberately with `bun scripts/gryd-agent-vectors.ts <grid-repo-root>`;
review source hash/action-list changes rather than blindly accepting drift.
Neither tests nor the packaged CLI require a Gryd checkout.

## Direct-send fee ceiling

`send <to-address> <sats> --max-fee <fee-sats> [note]` optionally bounds the
**actual miner fee**, not the payout. The signer validates each source transaction
and checks input value minus all outputs (including omitted zero/one-sat change)
before reserving, signing or broadcasting. Equality is accepted. Local payout caps,
allowlist, killfile and any signed BRC-181 policy still apply; the stricter fee
ceiling wins. This option never installs or modifies policy.

The flag must follow the address and payout, with a separate decimal-digits token
in the range 0 through 9007199254740991. Missing/duplicate flags, unknown options,
`--max-fee=500`, signs, fractions, exponent/hex notation and whitespace in the fee
token are rejected before funding lookup. Ordinary multiword notes still work;
use `--` before literal note tokens beginning with `-` (all remaining tokens then
become the note). Put the fee flag **before** that separator.

Library callers use `sendPayment({ ..., maxFeeSats })`: invalid caps return
`BAD_MAX_FEE` before vault/network access; excessive actual fees return `FEE_CAP`
before reservation/signing. These refusals leave no new payment hold or spend row.
Existing holds are never cleared. Ambiguous broadcast failures still retain holds;
see [payment recovery](docs/payment-recovery.md), and never automatically retry.
Omitting the option adds no new ceiling; local caps still count payout only.
This option is limited to direct-send API/CLI, not MCP or other rails. It is not a
preview, confirmation prompt, total-debit budget, or single-use approval token.
For a separately approved owner-operated payment, use the
[one-payment approval packet](docs/one-payment-acceptance.md).

## Paying HTTP 402

```bash
bun src/cli.ts x402-pay <url>
```

Tries rails in order — **BSV sats → Base USDC → Solana USDC** — switching only on `UNSUPPORTED`, never after a policy, funding, or settlement refusal. Every rail goes through policy first: per-asset caps, destination allowlist, killfile. Successful payments log spend rows and print the on-chain receipt.

- **BSV** (`bsv-direct` scheme, BRC-0121-flavored): the client builds and signs the full transaction; the merchant validates and broadcasts. 0-conf accepted for sub-cent prices.
- **Base USDC** (x402 `exact`, EIP-3009): signed `transferWithAuthorization` settled by a facilitator — ours can be self-hosted (below), so no Coinbase account or business entity is needed.
- **Solana USDC** (x402 `exact`): partially-signed versioned transaction; the merchant co-signs as fee payer and submits, so the payer needs no SOL.

## Running a merchant

```sh
DOGFOOD_MERCHANT_PAYTO=0x… \
DOGFOOD_MERCHANT_BSV_PAYTO=1… \
bun src/cli.ts merchant 8410
curl -i http://127.0.0.1:8410/v1/fortune   # → 402 with a price menu
```

Env knobs: `DOGFOOD_MERCHANT_PRICE` (USDC base units), `DOGFOOD_MERCHANT_NETWORK` (`base` / `base-sepolia`), `DOGFOOD_MERCHANT_BSV_SATS` (default 500), `DOGFOOD_MERCHANT_SOL_NETWORK` (`solana` / `solana-devnet`), `X402_FACILITATOR_URL`, `DOGFOOD_SELF_FACILITATE=1` (settle Base yourself: gas from the vault's ETH, key never leaves the machine), `DOGFOOD_MERCHANT_STATE` (replay ledger path — file-backed, survives restarts, append-before-broadcast).

The merchant validates before settling: amount, payee, mint, unspent inputs, nonce reuse, signature recovery, replay ledger reservation. A `Dockerfile.merchant` + `fly.toml` deploy the keyless public variant (BSV-direct + testnet USDC) in one `fly deploy`.

## MCP

```bash
bun src/cli.ts mcp
```

Claude Desktop example (replace all absolute paths; no client `cwd` support assumed):

```json
{
  "mcpServers": {
    "dogfood-wallet": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/dogfood-wallet/src/cli.ts", "mcp"],
      "env": { "DOGFOOD_WALLET_DIR": "/absolute/path/to/selected/vault" }
    }
  }
}
```

Use your client's documented config schema, with the same absolute executable/script paths and explicit vault environment. See the [connection walkthrough](docs/quickstart.md#4-connect-one-agent-choose-stdio-or-http).

`x402_pay({ url })` uses the same payment orchestration as CLI `x402-pay`: **BSV sats → Base USDC → Solana USDC**, falling through only on `UNSUPPORTED`. Policy, funding, and settlement errors stop immediately. Caps, allowlists, killfile, optional BRC-181 envelope checks on every rail, and per-asset spend logs apply on both surfaces. Base and Solana require human-configured `evm.usdc` / `solana.usdc` policy blocks. Success returns the selected rail's CLI result shape; failures return `isError: true` with `{ ok: false, code, message }`.

HTTP (loopback, stateless POST `/mcp`):

```bash
bun src/cli.ts mcp-http
```

Default `http://127.0.0.1:38402/mcp`. Override `DOGFOOD_MCP_HOST` / `DOGFOOD_MCP_PORT`. Binding anything other than loopback **requires** `DOGFOOD_MCP_TOKEN` (Bearer). Health: `GET /health`. Same tools as stdio — no `allow`, no `sweep`. Do not put this on Fly without the token; the signer is on this machine.

## Policy

| Gate | Result |
|---|---|
| Empty / miss allowlist | `REJECTED: Allowlist is empty` / `not on the allowlist` |
| Amount > per-tx cap | `REJECTED: Exceeds cap of N sats/tx` |
| Daily cap | `REJECTED: Exceeds daily cap of N sats (spent X, requested Y)` |
| Lifetime cap | `REJECTED: Exceeds lifetime cap of N sats` |
| Killfile on | `REJECTED: Killfile STOP_SPENDING is on` |
| Bad address | `REJECTED: Destination is not a mainnet P2PKH address` |
| Empty vault | `REJECTED: Insufficient funds` |

USDC rails have their own blocks (`evm.usdc`, `solana.usdc`) with the same allowlist + killfile semantics. The signer fails closed. The agent should pivot (cheaper source, stop), not retry with a new wallet.

## Payment concurrency and recovery

CLI/MCP `send`, `x402-pay` and `x402-delegate`, plus owner-only `split` and `allowance-fund`, share a per-vault cross-process lock acquired before policy/usage reads. A durable pending intent is recorded before signing; uncertain outcomes retain a hold instead of permitting another payment. Successful payments release it only after durable spend accounting. Split records zero transferred amount and its miner fee separately: all outputs return to the vault, and no amount or fee is charged to daily/lifetime spend caps. Kill still blocks split. Inspect without unlocking with `bun src/cli.ts payment-inspect`.

Owner `bridge-rebalance` shares the lock for guarded funding; explicit owner `bridge-reconcile` verifies settlement before releasing exposure (see below). This does **not** cover direct lower-level library helpers, `sendRaw`, fee delegator or merchant replay state. Allowance funding preserves private per-funding recovery records before broadcast and releases only after durable accounting and a completion marker. Do not run excluded spenders concurrently with guarded payments or use them to bypass a hold. Emergency owner `sweep` and `allowance-sweep` deliberately bypass the guard; **stop all spenders first** because sweeping does not cancel an in-flight payment. Kill remains available. There is no automatic hold expiry or clear command. See [payment recovery and scope limitations](docs/payment-recovery.md) before operating unattended.

## Bridge: guarded funding and owner reconciliation

`bridge-rebalance [sats]` creates one order and deposits once under the shared
payment guard. Without an amount, the configured low-water threshold applies.
It returns `awaiting-reconciliation`, **not** completed-swap success. Ambiguity
retains a durable exposure hold; never retry the deposit automatically.

`bridge-status [orderId|intentId]` is local and read-only. Explicit owner
`bridge-reconcile <intentId>` validates the exact provider order, independently
confirmed BSV deposit and native Base USDC receipt/log evidence, writes actual
arrival accounting exactly once, and releases only its own exclusive transition.
The Base receipt must be newer than a canonical block boundary pinned durably
before order creation. This prevents historical receipt replay, **not** dishonest
provider attribution of a contemporaneous transfer: the provider still asserts
the deposit/order/payout relationship. Signed BRC-181 budgets combine ordinary
and bridge BSV debits (principal plus fees); local policy caps stay separate.
It never steals a live or abandoned execution lock. Emergency sweeps remain
available and do not erase holds/history. All bridge commands remain off MCP.

See [bridge lifecycle and limitations](docs/bridge-lifecycle.md) and
[official provider contracts / synthetic fixture provenance](docs/bridge-provider-contracts.md).
This branch has offline synthetic coverage, **not live funded acceptance or
provider compatibility proof**. Legacy order-only quarantine records remain
held and are not silently migrated into funded evidence.

## Merkle Works x402 (payer)

```bash
bun src/cli.ts x402-inspect <X402-Challenge>
bun src/cli.ts x402-proof <X402-Challenge> <rawtx-hex>
bun src/cli.ts x402-delegate <X402-Challenge>
```

Uses frozen vectors from `testdata/x402-vectors-v1.json` (canonical JSON, SHA-256, base64url, header binding, body hash, Bitcoin txid).

`x402-delegate` POSTs `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402` (Merkle Works wire format), then builds `X402-Proof`. Unset URL → `NEED_DELEGATOR` (no fetch, no demo host). Policy still gates the payee. Broadcast is **off** unless `--broadcast` or `DOGFOOD_X402_BROADCAST=1`. Default sponsored mode does not sign or spend vault coins and never logs a local spend. `--vault-fund` (MCP `vault_fund: true`) **does spend local coins**. Both modes respect an existing payment hold.

Guarded client funding is deliberately bounded: one funding UTXO with positive change, source hash/value/script verified, and **SIGHASH_ALL|FORKID|ANYONECANPAY (0xC1)** to commit the payee and change. The delegator may append fee inputs, **not outputs/change**. The old SINGLE signature commits only the paired change output, not the payee; validating a later response cannot undo an unsafe signature already sent. Multi-UTXO, exact-value, and output-appending client completions are unsupported here (the low-level legacy fixture helper remains available, not agent-wired). This may reject existing delegators that require their own change output; no compatibility or live-settlement claim is made.

Before signing, intent is durably recorded. Signed bytes sent to a delegator are spending exposure **even when broadcast is off**: that path returns `PAYMENT_HELD`, no proof-as-success and no completed-spend row, and retains the hold for human reconciliation. Opt-in broadcast releases only after validating completed transaction bytes/ID, payee, unchanged client inputs/outputs, source values/scripts, input signatures, no extra local funding, exact vault debit, matching broadcaster ID, and durable accounting. Ambiguity, rejection, signing/log failure, or process death stays held. Sponsored templates are checked for local inputs before forwarding; completed sponsored transactions are validated but never charged to vault usage.

## BRC-0204 (script + descriptor, not a live allowance)

[BRC-0204](https://bsv.brc.dev/wallet/0204) is a two-branch lock: the agent spends with `OP_1`, the owner sweeps with `OP_0`, plus a 1-sat revocation output. Dogfood **funds and owner-sweeps** that shape. Locking keys are Type42-derived (`protocolID` `[2, "agent allowance"]`, `keyID` = `allowanceId`, counterparty = agent identity). The vault key is the owner **identity**, not the key on the lock. Fund also issues a BRC-52 core certificate (type = SHA-256 of `agent allowance`) signed by the owner, bound to the revocation outpoint. Field revelation keyring stays on disk; it is not printed. `proveAllowanceCertificate` (library, not CLI) lets an **agent `ProtoWallet`** reveal selected fields to a verifier. Never pass an agent WIF on a CLI.

```bash
bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
bun src/cli.ts allowance-inspect <descriptor-json-or-file>
```

Human-only. Not MCP. Owner identity is the vault key. Allowance locking keys are Type42 children. Agent identity is the pubkey you pass in.

```bash
bun src/cli.ts allowance-fund <agent-pubkey-hex> <sats> [pieces]
bun src/cli.ts allowance-list
bun src/cli.ts allowance-sweep [p2pkh-address]
bun src/cli.ts allowance-sweep --record <record-id> [p2pkh-address]
```

`allowance-fund` spends vault coins into the two-branch lock plus a 1-sat revocation output. Counts against sat caps. Killfile blocks it. Empty allowlist does **not** (destination is a script). `allowance-sweep` spends the owner branch + revocation even if the killfile or payment hold is on. **Stop all spenders first.**

New funding writes immutable, private `allowances/<funding-txid>.json` (signed transaction, descriptor, certificate and master keyring) before broadcast, and `<funding-txid>.accounted.json` only after matching broadcaster acknowledgement and fsynced accounting. Repeated funding never replaces earlier records. `allowance-list` is sanitized/offline; its `accounted` status is a local completion marker, not confirmation or unspent status. Results/CLI output exclude the master keyring. New files request mode 0600 and the directory 0700; Windows owners must protect the vault with filesystem ACLs.

Existing `allowance.json` is read in place as record ID `legacy`, never overwritten or silently migrated. Missing historical descriptors/keyrings cannot be reconstructed. With multiple records, sweeping requires `--record <funding-txid>` or `--record legacy`; the default refuses ambiguity. Sweeps preserve all history and do not resolve funding holds. Explicit selection can recover a valid record despite unrelated corrupt history. Ambiguous funding is **not retryable**: no automatic rebroadcast, accounting repair, hold clearing, or delegated allowance-spending feature is provided. See [recovery limits](docs/payment-recovery.md#allowance-funding-lifecycle).

## BRC-181 policy inspect

```bash
bun src/cli.ts policy-inspect <envelope-json-or-file>
```

Verifies a signed `brc-181/agent-policy/1` envelope against frozen vectors (`testdata/brc-181-vectors.json`). Canonical dests are `p2pkh:<hash160>` / `script:<sha256>` on BSV (OP_RETURN is not a dest), `evm:<lowercase address>` on Base, and `solana:<base58 address>` on Solana. Human-only inspect. Not MCP.

Mint an envelope with the vault key as issuer (human-only, not MCP):

```bash
bun src/cli.ts policy-issue --origin <token> --per-tx <n> --total <n> --max-fee <n> --purpose <text> \
  [--allow <dest>]... [--dest-cap <dest>=<n>]... [--expires <epoch>] [--write] [--force]
```

Prints the signed envelope JSON; `--write` installs it as the vault's `brc181.json` (refuses to replace an installed envelope without `--force`). Destinations are always prefixed canonical forms — `p2pkh:` / `script:` / `evm:` / `solana:` — never raw addresses, and `evm:` dests are lowercase. Caps are in the native units of the rail being charged. Review any installed envelope with `policy-inspect ~/.dogfood-wallet/brc181.json`.

If the vault contains `brc181.json`, **every payment rail verifies the envelope and enforces it** (AND with local `policy.json`): `send`, `x402-delegate`, and `x402-pay` on BSV, Base USDC, and Solana USDC alike. Numeric envelope fields are read in the native units of the rail's asset (sats on BSV, USDC base units on the dollar rails); the facilitator pays gas on USDC settles, so their client-side fee is 0. Origin is `DOGFOOD_ORIGIN_TOKEN` or the record's `origin_token`. Sweep/split ignore the envelope. A Vector A `max_fee` of 100 sats will reject a typical P2PKH fee — issue a record with a real fee cap. x402-delegate charges local fee 0 because its sponsor covers fees; client-funded mode still debits and accounts the challenge amount. Envelope budgets draw from their own per-rail log scopes (`brc181-bsv`, `brc181-usdc-base`, `brc181-usdc-solana`), kept separate from ordinary policy usage.

## Not this

- Not the shared Hermes QA treasury (`1Gjc…`). That key stays private.
- Not Yours Wallet / BSV Association mobile (those are for humans).
- Not Coinbase-style hosted custody.
- Not an x402 **gateway**. Merkle Works [x402 v1](https://github.com/ruidasilva/merkleworks-x402-spec) is the BSV paywall we intend to *pay*. We do not vendor their Go gateway.
- Not a business. MIT, free forever, no revenue cut built in.

## Later

- Live Merkle Works delegator URL (you set `DOGFOOD_X402_DELEGATOR_URL`; we do not start their gateway)

## Dev

```bash
bun install --frozen-lockfile
bun run verify  # strict root TypeScript check, then full Bun tests
```

`bun run typecheck` checks all `src/**/*.ts`, including tests and subprocess
fixtures. The independent JavaScript site uses its own lockfile:

```bash
cd site
bun install --frozen-lockfile
bun test
bun run build
```

See [local release verification and remaining gates](docs/release-verification.md).

MIT. Keys never belong in git, logs, or MCP responses.
