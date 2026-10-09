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

Needs [Bun](https://bun.sh).

```bash
git clone https://github.com/futureman19/dogfood-wallet
cd dogfood-wallet
bun install
bun src/cli.ts init
```

Fund the printed address. Default vault: `~/.dogfood-wallet` (override with `DOGFOOD_WALLET_DIR`). New vaults: **10,000 sats/tx**, **50,000 sats/day**, **empty allowlist** (a human must `allow` a destination before the agent can send). EVM and Solana addresses derive from the same secret — print them with `evm-address` / `sol-address`.

```bash
bun src/cli.ts address                 # BSV
bun src/cli.ts evm-address             # Base/EVM
bun src/cli.ts sol-address             # Solana
bun src/cli.ts balance                 # plus evm-balance / sol-balance
bun src/cli.ts status
bun src/cli.ts allow <address>         # per-chain policy blocks
bun src/cli.ts send <p2pkh-address> <sats> [note]
bun src/cli.ts fund-request <sats>
# or paste that address into the Yours button on https://dogfoodwallet.com
bun src/cli.ts kill                    # writes STOP_SPENDING
bun src/cli.ts sweep <p2pkh-address>
bun src/cli.ts split [piece-sats]
```

`allow`, `sweep`, `split`, and `fund-request` are **human-only** — not MCP tools. Sweep bypasses caps, allowlist, and killfile so the owner can take funds back. Split turns one fat UTXO into up to 20 even self-outputs so later agent sends are not serialized on a single coin. Split does **not** count against daily/lifetime caps. A **human** deletes `STOP_SPENDING` to resume agent sends. Agents must not.

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

Claude Desktop / Cursor example:

```json
{
  "mcpServers": {
    "dogfood-wallet": {
      "command": "bun",
      "args": ["src/cli.ts", "mcp"],
      "cwd": "/absolute/path/to/dogfood-wallet"
    }
  }
}
```

Hermes: same command, or `bun src/mcp.ts`.

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

## Merkle Works x402 (payer)

```bash
bun src/cli.ts x402-inspect <X402-Challenge>
bun src/cli.ts x402-proof <X402-Challenge> <rawtx-hex>
bun src/cli.ts x402-delegate <X402-Challenge>
```

Uses frozen vectors from `testdata/x402-vectors-v1.json` (canonical JSON, SHA-256, base64url, header binding, body hash, Bitcoin txid).

`x402-delegate` POSTs `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402` (Merkle Works wire format), then builds `X402-Proof`. Unset URL → `NEED_DELEGATOR` (no fetch, no demo host). Policy still gates the payee. Broadcast is **off** unless `--broadcast` or `DOGFOOD_X402_BROADCAST=1`. The merchant nonce UTXO is theirs; Dogfood does not spend local vault coins on it.

## BRC-0204 (script + descriptor, not a live allowance)

[BRC-0204](https://bsv.brc.dev/wallet/0204) is a two-branch lock: the agent spends with `OP_1`, the owner sweeps with `OP_0`, plus a 1-sat revocation output. Dogfood **funds and owner-sweeps** that shape. Locking keys are Type42-derived (`protocolID` `[2, "agent allowance"]`, `keyID` = `allowanceId`, counterparty = agent identity). The vault key is the owner **identity**, not the key on the lock. Fund also issues a BRC-52 core certificate (type = SHA-256 of `agent allowance`) signed by the owner, bound to the revocation outpoint. Field revelation keyring stays on disk; it is not printed. `proveAllowanceCertificate` (library, not CLI) lets an **agent `ProtoWallet`** reveal selected fields to a verifier. Never pass an agent WIF on a CLI.

```bash
bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
bun src/cli.ts allowance-inspect <descriptor-json-or-file>
```

Human-only. Not MCP. Owner identity is the vault key. Allowance locking keys are Type42 children. Agent identity is the pubkey you pass in.

```bash
bun src/cli.ts allowance-fund <agent-pubkey-hex> <sats> [pieces]
bun src/cli.ts allowance-sweep [p2pkh-address]
```

`allowance-fund` spends vault coins into the two-branch lock plus a 1-sat revocation output. Counts against sat caps. Killfile blocks it. Empty allowlist does **not** (destination is a script). `allowance-sweep` spends the owner branch + revocation even if the killfile is on.

## BRC-181 policy inspect

```bash
bun src/cli.ts policy-inspect <envelope-json-or-file>
```

Verifies a signed `brc-181/agent-policy/1` envelope against frozen vectors (`testdata/brc-181-vectors.json`). Canonical dest is `p2pkh:<hash160>` or `script:<sha256>`; OP_RETURN is not a dest. Human-only inspect. Not MCP.

If the vault contains `brc181.json`, **`send` and `x402-delegate` also verify the envelope and enforce it** (AND with local `policy.json`). Origin is `DOGFOOD_ORIGIN_TOKEN` or the record's `origin_token`. Sweep/split ignore the envelope. A Vector A `max_fee` of 100 sats will reject a typical P2PKH fee — issue a record with a real fee cap. x402-delegate treats merchant fee as 0 (Dogfood does not spend local coins on the nonce UTXO).

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
bun test
```

MIT. Keys never belong in git, logs, or MCP responses.
