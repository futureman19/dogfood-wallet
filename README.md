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

`x402-delegate` POSTs `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402` (Merkle Works wire format), then builds `X402-Proof`. Unset URL → `NEED_DELEGATOR` (no fetch, no demo host). Policy still gates the payee. Broadcast is **off** unless `--broadcast` or `DOGFOOD_X402_BROADCAST=1` (uses the same GorillaPool ARC path as `send`). The merchant nonce UTXO is theirs; Dogfood does not spend local vault coins on it.

## BRC-0204 (script + descriptor, not a live allowance)

[BRC-0204](https://bsv.brc.dev/wallet/0204) is a two-branch lock: the agent spends with `OP_1`, the owner sweeps with `OP_0`, plus a 1-sat revocation output. Dogfood **funds and owner-sweeps** that shape. Locking keys are Type42-derived (`protocolID` `[2, "agent allowance"]`, `keyID` = `allowanceId`, counterparty = agent identity). The vault key is the owner **identity**, not the key on the lock. Fund also issues a BRC-52 core certificate (type = SHA-256 of `agent allowance`) signed by the owner, bound to the revocation outpoint. Field revelation keyring stays on disk; it is not printed. Selective reveal to a payee is not implemented (needs the agent's key).

```bash
bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
bun src/cli.ts allowance-inspect <descriptor-json-or-file>
```

Human-only. Not MCP. Owner identity is the vault key. Allowance locking keys are Type42 children. Agent identity is the pubkey you pass in. Not a BRC-52 certificate.

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

## Later

- Live Merkle Works delegator URL (you set `DOGFOOD_X402_DELEGATOR_URL`; we do not start their gateway)
- BRC-52 selective reveal / proveCertificate for a payee (agent wallet)
- PeerPay / BRC-100 funding from Yours

## Dev

```bash
bun test
```

MIT. Keys never belong in git, logs, or MCP responses.
