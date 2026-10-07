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
- CLI: `bun src/cli.ts` (`init` / `address` / `balance` / `status` / `allow` / `send` / `kill` / `sweep` / `split` / `x402-inspect` / `x402-proof` / `x402-delegate` / `allowance-script` / `allowance-inspect` / `allowance-fund` / `allowance-sweep` / `policy-inspect` / `mcp` / `mcp-http`)
- Tests: `bun test` from the repo root before commit. Push `main` after green.
- x402 vectors: `testdata/x402-vectors-v1.json` (Merkle Works v1 frozen). Codec lives in `src/x402.ts`.

**Not** the shared Hermes treasury at `C:/Users/futur/.hermes/agent-treasury` (`1Gjc…`). Never copy `wif.enc` / `wrap.key` between them. Never print the WIF.

## Procedure

1. `git status --short` in `Desktop/dogfood-wallet` only.
2. TDD on policy/send/vault: write the failing test, run `bun test`, then the minimum signer change.
3. Policy lives in `src/policy.ts` (`evaluateSend` + `usageFromLog`). Wire usage from `spends.jsonl` in `sendPayment` — do not re-check caps only in the CLI.
4. Human-only mutations (`allow`, `sweep`, `split`, `fund-request`, `allowance-script`, `allowance-inspect`, `allowance-fund`, `allowance-sweep`, `policy-inspect`, deleting `STOP_SPENDING`) stay off MCP. Agents get `address` / `balance` / `status` / `send` / `kill` / `x402_inspect` / `x402_proof` / `x402_delegate`. Sweep bypasses caps/allowlist/killfile so the owner can reclaim funds. Split is self-send pocket change (killfile still applies; does not eat spend caps). `fund-request` prints a Yours/BRC-100 `createAction` payload to the vault P2PKH; it does not talk to Yours.
5. x402: inspect + proof + delegator client. `x402-delegate` / `x402_delegate` POST `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402`. If they ask “what URL” / whether to paste one: it is that **delegator base** (not `/v1/expensive`, not MCP, not GitHub). Local Merkle Works `make demo` base is `http://localhost:8402`; merchant check is `GET /v1/expensive`. Unset URL → NEED_DELEGATOR, no fetch, no demo host, do not start their gateway. Broadcast is off unless `--broadcast` / `broadcast: true` / `DOGFOOD_X402_BROADCAST=1` (ARC, same as send). Coin selection is smallest-first so split pocket-change is actually used.
6. BRC-0204: script + descriptor + fund/sweep + BRC-52 issue. Locking keys are Type42 (`[2, "agent allowance"]`, keyID = allowanceId). Vault key is owner identity. Fund issues a signed BRC-52 core cert bound to the revocation outpoint. masterKeyring stays on disk, not printed, not MCP. `proveAllowanceCertificate` is a library call with an injected agent `ProtoWallet` — never a WIF on the CLI.
7. BRC-181: inspect/verify a signed PolicyRecord (`src/brc181.ts`) against `testdata/brc-181-vectors.json`. If vault `brc181.json` exists, `sendPayment` and `settleX402` AND it with local `policy.json` (`gateAgentSend`). Origin: `DOGFOOD_ORIGIN_TOKEN` or the record. Sweep/split skip it. x402 fee is 0 (no local nonce spend). Not concurrent ledger. Not MCP install.
8. Splash (`site/`): Vite + React + Tailwind. Deploy with `vercel --prod` from `site/` (project `dogfood-wallet`). Public check is `https://dogfood-wallet.vercel.app` — preview `*.vercel.app` deployment URLs can require Vercel SSO; do not use those to verify. Domain `dogfoodwallet.com` is attached on Vercel; GoDaddy DNS is a separate step (`references/splash-and-domain.md`). When the user pastes mock JSX or a Gemini share, match that look. Do not substitute a different aesthetic or rewrite mock copy into product-truth CLI.
9. `bun test` (repo root, not `site/`), commit, `git push origin main`.

## Product rules

- Stay TypeScript/Bun + `@bsv/sdk`. Do not rewrite in Rust or Zig to “be better for AI.” NullClaw is an MCP *client* (no chain, no wallet) — config snippet later; do not fuse it or put keys in it.
- Caps in satoshis, not USD. No agent `refund`. Sweep is owner-side (`evaluateSweep` / `sweepPayment`), CLI-only.
- Merkle Works x402 v1 (`bsv-tx-v1`) is the BSV paywall to *pay*. Coinbase x402 (USDC) is a different protocol. Do not vendor their Go gateway into this repo. `locus-mcp-server` is keyless HTTP MCP for Locus — copy the “no keys on Fly” rule, not the tools.
- New vaults: 10k sats/tx, 50k sats/day, no lifetime cap, **empty allowlist**. `allow <p2pkh>` is CLI-only. Empty allowlist denies every send until a human adds a destination. Legacy `policy.json` with no `allowlist` key stays unrestricted (`null`).
- Daily/lifetime usage is UTC day + lifetime sum of `amount` on `spends.jsonl`. Skip malformed lines; do not fail the whole log.
- Open source, not a hosted custodian.

## Next slices (user picks)

1. Point `DOGFOOD_X402_DELEGATOR_URL` at a live Merkle Works `make demo` (client + opt-in broadcast are shipped; we do not start their gateway)

## Pitfalls

- `init` creates a **new** key in `~/.dogfood-wallet`. Do not init if you meant the shared treasury, and do not copy that key into git.
- After `init`, `send` fails `ALLOWLIST` until `allow` — that is fail-closed, not a bug. Do not default allowlist to unrestricted to make tests pass; call `allowDestination` in fixtures instead.
- MCP must not log secrets to stdout (JSON-RPC uses stdout).
- Fail closed on cap/kill/allowlist/bad address; do not mint another wallet as a workaround.
- Matching x402 canonical JSON/hash vectors is inspect compliance, not a paid 402. Do not tell the user agents can settle paywalls until they set `DOGFOOD_X402_DELEGATOR_URL` and a real challenge is paid.
- `p2pkhAddressFromLock` only accepts `76a914…88ac`. Non-P2PKH payee scripts are `BAD_PAYEE` — do not invent a generic script sender to “make 402 work.”
- Splash CTA `$ npm i -g @dogfood/wallet` is display; link it to the GitHub repo until that package exists. Real install remains `bun src/cli.ts init`. Signer/docs stay in sats even if the mock terminal shows USD.
- `gddy auth login` is browser PKCE on localhost. Do not start it from a phone session and do not ask for a PAT in chat. Wait for “login” at the PC.
