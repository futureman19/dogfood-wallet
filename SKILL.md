---
name: dogfood-wallet
description: Use when developing the Dogfood Wallet BSV vault.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [bsv, wallet, mcp, agents]
    related_skills: [agent-bsv-treasury, wallet-send-bsv]
---

# Dogfood Wallet

Local BSV agent vault: LLM requests payment; a signer on disk authorizes it.

- Repo: `C:/Users/futur/Desktop/dogfood-wallet`
- GitHub: https://github.com/futureman19/dogfood-wallet (public, MIT)
- Vault dir: `~/.dogfood-wallet` (`DOGFOOD_WALLET_DIR` override)
- CLI: `bun src/cli.ts` (`init` / `address` / `balance` / `status` / `allow` / `send` / `kill` / `sweep` / `x402-inspect` / `mcp` / `mcp-http`)
- Tests: `bun test` from the repo root before commit. Push `main` after green.
- x402 vectors: `testdata/x402-vectors-v1.json` (Merkle Works v1 frozen). Codec lives in `src/x402.ts`.

**Not** the shared Hermes treasury at `C:/Users/futur/.hermes/agent-treasury` (`1Gjc…`). Never copy `wif.enc` / `wrap.key` between them. Never print the WIF.

## Procedure

1. `git status --short` in `Desktop/dogfood-wallet` only.
2. TDD on policy/send/vault: write the failing test, run `bun test`, then the minimum signer change.
3. Policy lives in `src/policy.ts` (`evaluateSend` + `usageFromLog`). Wire usage from `spends.jsonl` in `sendPayment` — do not re-check caps only in the CLI.
4. Human-only mutations (`allow`, `sweep`, deleting `STOP_SPENDING`) stay off MCP. Agents get `address` / `balance` / `status` / `send` / `kill` / `x402_inspect` only. Sweep bypasses caps/allowlist/killfile so the owner can reclaim funds.
5. x402 work is **payer inspect** until settlement is explicitly in scope: decode `X402-Challenge`, map P2PKH payee, run `evaluateSend`. Do not broadcast a 402 payment and do not spend the merchant nonce UTXO without their delegator.
6. `bun test`, commit, `git push origin main`.

## Product rules

- Stay TypeScript/Bun + `@bsv/sdk`. Do not rewrite in Rust or Zig to “be better for AI.” NullClaw is an MCP *client* (no chain, no wallet) — config snippet later; do not fuse it or put keys in it.
- Caps in satoshis, not USD. No agent `refund`. Sweep is owner-side (`evaluateSweep` / `sweepPayment`), CLI-only.
- Merkle Works x402 v1 (`bsv-tx-v1`) is the BSV paywall to *pay*. Coinbase x402 (USDC) is a different protocol. Do not vendor their Go gateway into this repo. `locus-mcp-server` is keyless HTTP MCP for Locus — copy the “no keys on Fly” rule, not the tools.
- New vaults: 10k sats/tx, 50k sats/day, no lifetime cap, **empty allowlist**. `allow <p2pkh>` is CLI-only. Empty allowlist denies every send until a human adds a destination. Legacy `policy.json` with no `allowlist` key stays unrestricted (`null`).
- Daily/lifetime usage is UTC day + lifetime sum of `amount` on `spends.jsonl`. Skip malformed lines; do not fail the whole log.
- Open source, not a hosted custodian.

## Next slices (user picks)

1. x402 **settlement** via a live Merkle Works delegator (inspect + vector codec shipped; nonce UTXO is theirs)
2. UTXO pocket-change for concurrent 402s

## Pitfalls

- `init` creates a **new** key in `~/.dogfood-wallet`. Do not init if you meant the shared treasury, and do not copy that key into git.
- After `init`, `send` fails `ALLOWLIST` until `allow` — that is fail-closed, not a bug. Do not default allowlist to unrestricted to make tests pass; call `allowDestination` in fixtures instead.
- MCP must not log secrets to stdout (JSON-RPC uses stdout).
- Fail closed on cap/kill/allowlist/bad address; do not mint another wallet as a workaround.
- Matching x402 canonical JSON/hash vectors is inspect compliance, not a paid 402. Do not tell the user agents can settle paywalls until nonce-UTXO spend is implemented and tested.
- `p2pkhAddressFromLock` only accepts `76a914…88ac`. Non-P2PKH payee scripts are `BAD_PAYEE` — do not invent a generic script sender to “make 402 work.”
