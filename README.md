# Dogfood Wallet

Local BSV agent vault. The LLM requests payment. A signer on your machine authorizes it. The model never sees the key.

Open source. Not a hosted wallet. Not a consumer portfolio app.

## Architecture

1. **Brain (agent)** — knows what to buy. Tools: `address`, `balance`, `status`, `send`, `kill`, `x402_inspect`, `x402_proof`, `x402_delegate`.
2. **Vault (this repo)** — keys, sat cap, killfile, structured rejects.
3. **Settlement** — BSV mainnet. Tiny fees so per-call payments are real.

Caps are in **satoshis**, not USD. There is no `refund` tool. Sweep/recovery is the owner’s job, not the agent’s.

## Install

Needs [Bun](https://bun.sh).

```bash
git clone https://github.com/futureman19/dogfood-wallet
cd dogfood-wallet
bun install
bun src/cli.ts init
```

Fund the printed address. Default vault: `~/.dogfood-wallet` (override with `DOGFOOD_WALLET_DIR`). New vaults: **10,000 sats/tx**, **50,000 sats/day**, **empty allowlist** (a human must `allow` a destination before the agent can send).

```bash
bun src/cli.ts address
bun src/cli.ts balance
bun src/cli.ts status
bun src/cli.ts allow <p2pkh-address>
bun src/cli.ts send <p2pkh-address> <sats> [note]
bun src/cli.ts kill
bun src/cli.ts sweep <p2pkh-address>
bun src/cli.ts split [piece-sats]
```

`allow`, `sweep`, and `split` are **human-only** — not MCP tools. Sweep bypasses caps, allowlist, and killfile so the owner can take funds back. Split turns one fat UTXO into up to 20 even self-outputs (default piece 10k sats, min 1k) so later agent sends are not serialized on a single coin. Split does **not** count against daily/lifetime caps. `kill` writes `STOP_SPENDING`. A **human** deletes that file to resume agent sends. Agents must not.

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

The signer fails closed. The agent should pivot (cheaper source, stop), not retry with a new wallet.

## Not this

- Not the shared Hermes QA treasury (`1Gjc…`). That key stays private.
- Not Yours Wallet / BSV Association mobile (those are for humans).
- Not Coinbase-style hosted custody.
- Not an x402 **gateway**. Merkle Works [x402 v1](https://github.com/ruidasilva/merkleworks-x402-spec) is the BSV paywall we intend to *pay*. We do not vendor their Go gateway.

## x402 (payer)

```bash
bun src/cli.ts x402-inspect <X402-Challenge>
bun src/cli.ts x402-proof <X402-Challenge> <rawtx-hex>
bun src/cli.ts x402-delegate <X402-Challenge>
```

Uses frozen vectors from `testdata/x402-vectors-v1.json` (canonical JSON, SHA-256, base64url, header binding, body hash, Bitcoin txid).

`x402-delegate` POSTs `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402` (Merkle Works wire format), then builds `X402-Proof`. Unset URL → `NEED_DELEGATOR` (no fetch, no demo host). Policy still gates the payee. **Does not broadcast.** The merchant nonce UTXO is theirs; Dogfood does not spend local vault coins on it.

## Later

- BRC-181 wallet-enforced policy
- BRC-0204 on-chain allowance the owner can sweep
- PeerPay / BRC-100 funding from Yours

## Dev

```bash
bun test
```

MIT. Keys never belong in git, logs, or MCP responses.
