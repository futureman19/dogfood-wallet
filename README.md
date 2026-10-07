# Dogfood Wallet

Local BSV agent vault. The LLM requests payment. A signer on your machine authorizes it. The model never sees the key.

Open source. Not a hosted wallet. Not a consumer portfolio app.

## Architecture

1. **Brain (agent)** — knows what to buy. Tools only: `address`, `balance`, `status`, `send`, `kill`.
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
```

`allow` is **human-only** — it is not an MCP tool. `kill` writes `STOP_SPENDING`. A **human** deletes that file to resume. Agents must not.

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
- Not HTTP 402 merchant rail (bsv.cx / BRC-166). This vault *pays* a 402; it is not the paywall.

## Later (not v0.1)

- BRC-181 wallet-enforced policy
- BRC-0204 on-chain allowance the owner can sweep
- UTXO pocket-change for concurrent 402s
- PeerPay / BRC-100 funding from Yours

## Dev

```bash
bun test
```

MIT. Keys never belong in git, logs, or MCP responses.
