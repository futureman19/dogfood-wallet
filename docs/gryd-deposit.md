# Gryd agent deposits (owner CLI only)

```sh
bun src/cli.ts agent-deposit <agent-id> <sats> [--no-broadcast]
```

**Default execution signs and broadcasts a mainnet payment.** Select the intended
`DOGFOOD_WALLET_DIR` explicitly. Rehearse only against intercepted transport and a
disposable, never-funded vault. This command is not exposed over MCP.

`agent-id` is 1..200 ASCII characters: first alphanumeric, then alphanumeric,
colon, underscore or hyphen. Sats must be a positive safe integer written in
 decimal digits (no exponent, hex, whitespace, fraction, sign or extra arguments).

## Exact transaction and result

- Output 0: requested positive sats to `GRYD_FUND`, exported by `gryd-buy.ts`:
  `18Jc1Rq5Aw54UpCNLNvwoTLN4Uv5reTjCa`.
- Output 1: zero sats, `OP_FALSE OP_RETURN`, exactly one push of UTF-8 JSON
  `{"type":"agent_fund","agent_id":"<agent-id>"}` in that field order.
  Direct pushes through 75 bytes; PUSHDATA1 thereafter; maximum payload 255 bytes.
  No extra fields, PUSHDATA2, trailing bytes or extra pushes.
- Output 2: positive change to the main vault P2PKH. Only main-address coins
  greater than one sat are eligible, smallest first. Property coins are not used.

The result includes `claim: {txid, vout: 0}` and
`agentPost: {route: {agentId}, body: {txid, vout: 0}}`, plus amount and actual
`minerFee`. A successful broadcast result has `mode: "broadcast", held: false`.
It is an acknowledgement, not mining confirmation or agent balance credit.
No Gryd POST is performed. Review the claim separately before using
`agent-post agent.fund '<agentPost JSON>'` with the correct owner identity.

**Accounting caveat:** the existing `agent-post agent.fund` path independently
checks policy and records the derived deposit amount again. Deposit plus claim
can therefore consume local/BRC-181 accounting twice. This command does not
silently exempt the later authorization, clear holds, or change that existing
behavior. Treat claim submission/identity compatibility as a separate review
step; do not assume this is an automated end-to-end funding flow.

## `--no-broadcast` is NOT an unsigned preview

Unlike `agent-buy`/`agent-mint` previews, deposit `--no-broadcast` **signs** and
prints usable `rawTx`, the future claim and `agentPost`, with `mode: "signed"`
and `held: true`. These bytes can spend funds if submitted by anyone. It writes
signed evidence and **retains the shared payment hold**, without a completed
spend row. Do not rerun to broadcast or delete the hold. The future claim is not
yet on-chain proof. Reconciliation is manual; see [payment recovery](payment-recovery.md).

## Fail-closed boundaries

The shared guard is acquired before policy/usage reads. Ordinary `evaluateSend`
checks amount, Fund destination, per-tx/day/lifetime caps, allowlist and killfile.
An empty allowlist denies; a scoped `policy.gryd` purchase budget does not grant
permission here. Installed BRC-181 policy is ANDed with the local policy and
receives the Fund destination, amount, cumulative BSV usage and actual
input-minus-output miner fee before signing. Fee estimation uses the existing
1 sat/byte SDK fee model; accounting uses actual input minus output value.

Funding raw bytes must hash to the requested txid, and source position, exact
P2PKH script and value must match the unspent triple. Fresh unspent and killfile
checks happen before signing and again after signing/evidence, immediately
before broadcast. Every signed input must pass SDK `Spend.validate()`; the
complete output shape is checked before and after signing. WoC is indexer
information, not SPV or protection against all concurrent spends.

Before network mutation (or printing raw bytes), an exclusive `wx`, mode 0600,
fsynced `gryd-deposits/<payment-guard-UUID>.json` stores signed bytes, txid,
source triples/scripts, amount, fee, claim and guard ID. No private keys are
stored there. Guard IDs prevent evidence overwrite even for identical bytes.
Windows ACL and directory-fsync/power-loss limitations of the guard still apply.

Evidence failure after reservation, signing failure, final spent/kill races,
broadcast errors and mismatched acknowledgement retain the hold. No command
retry or recovery/clearing command is provided. The existing single-attempt
`arcBroadcast` transport is reused directly: even explicit fee-policy rejection
is terminal, with no WoC fallback or automatic retry. Only an exact
returned txid permits fsynced amount-plus-fee accounting and guard release.
Stop other policy writers and unguarded spenders during operation.

## Pinned backend provenance

The parent fetched `origin/dev` read-only before implementation; this task also
inspected the full immutable blob at commit
`5db322ac97cbd0d6f1084d09003eed1ce6c2f58f` in
`C:/Users/futur/Desktop/the-grid-agent-splash`:

`locus-mobile/backend/locus_api/lib/locus_api/agent_wallet/deposit_verifier.ex`

Its `verify_deposit` requires a positive treasury output and an `agent_fund`
binding naming the agent. `binding_check` looks for `006a`; `read_push` supports
first direct pushes 1..75 or PUSHDATA1 (one-byte length). This wallet deliberately
emits a stricter closed single-push/two-field profile rather than exploiting the
backend's permissive extra/trailing data handling. The backend default treasury
matches `GRYD_FUND`, but is configurable through `:fee_address`: a deployment
that overrides it is **not compatible** with this fixed wallet destination.
No backend files or deployment configuration were changed, and no live spending
or backend acceptance was attempted.

`testdata/gryd-deposit-synthetic.json` is an independently SDK-assembled,
byte-frozen transaction using public synthetic scalar 1 and nonexistent funding.
Tests reproduce the whole signed transaction and txid, validate all inputs,
intercept CLI/default broadcast, exercise policy/chain/race/evidence/hold failures,
and extend the canonical `src/mcp.test.ts` runtime isolation check. Synthetic
signatures are not evidence of live settlement.
