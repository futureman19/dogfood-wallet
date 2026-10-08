# x402 v1 — client-funded settlement cannot be expressed by the current delegator

**Status:** interop report from an independent client implementation ([Dogfood Wallet](https://github.com/futureman19/dogfood-wallet))
**Date:** 2026-10-07
**Scope:** `merkleworks/x402-bsv` reference implementation and the frozen v1 wire protocol, delegation step

## Summary

The v1 spec describes delegation as fee coverage: the client "constructs a BSV transaction … paying the required amount to the payee," and "a fee delegator adds miner-fee inputs and signs only its own inputs." The reference client (`cmd/client/main.go`) does exactly this — it adds a client payment input signed `0xC1` (`SIGHASH_ALL | FORKID | ANYONECANPAY`) alongside the gateway nonce input.

The reference **delegator**, however, cannot account for client input value. Raw transaction bytes do not carry input amounts, and the delegation request carries none either, so the delegator's deficit loop counts only the nonce's 1 sat and funds **all outputs — payment plus any client change — from its own pool**. In practice this means:

1. **Profile B (template passthrough, no client input):** the gateway funds the payment to itself — a sponsored demo settlement. Works, but the client pays nothing.
2. **Client-funded partial with change:** the delegator tries to fund the client's change output as well, exhausts its pool, and returns `503 no_utxos_available`.
3. **Client-funded partial without change:** the client's entire input value above the payment amount burns as miner fee (a 10,000-sat input against a 100-sat payment ⇒ ~9,900-sat fee).

There is currently no request shape under which a client's own coins actually pay the payee.

## Evidence

**A. Live settlement where the client contributed zero value.**
Mainnet tx [`680ed99f1d4f5eb233e10aa5bc43c998edee8544a28059d40db1e306b848ac21`](https://whatsonchain.com/tx/680ed99f1d4f5eb233e10aa5bc43c998edee8544a28059d40db1e306b848ac21), settled against `https://demo.x402.merkleworks.io/v1/expensive` on 2026-10-07:

- Input 0: nonce UTXO `2bfed481…:853` (1 sat, gateway key)
- Input 1: fee-pool UTXO `fdf225d9…:652` (100 sats, delegator key)
- Output 0: 100 sats to the merchant payee
- Fee: 1 sat (340 bytes)

The settlement is protocol-valid and the resource unlocked with HTTP 200 — but all 100 sats of "payment" came from the gateway's own pool.

**B. Live `503 no_utxos_available` for a client-funded partial.**
Same endpoint, same day: partial tx with inputs [nonce (1 sat), client UTXO (10,000 sats, signed `0xC1`)] and outputs [payee 100 sats, client change 9,900 sats]. The delegator attempted to cover ~10,000 sats of outputs from its pool and refused. Reproduced locally against a fresh reference server (fee pool 100 × 100 sats): same error.

**C. Local reference-server log for the sponsored path** (`Profile B, sighash=0xC3`):

```
delegator: fee UTXOs leased count=1 total_fee_sats=100 payment_output_sats=100
delegator: delegation accepted … fee_inputs=1 fee_input_sats=100 output_sats=100 miner_fee_est=1 change_sats=0 client_inputs=1
gatekeeper: payment accepted … amount_sats=100
```

**D. Code references.**

- `internal/delegator/delegator.go` — Step 5 comment: "The nonce's 1 sat covers the miner fee; fee inputs cover the payment." The deficit loop sets `existingInputSats` from the nonce only ("Bitcoin raw tx bytes don't carry input amounts"), then leases pool UTXOs until `feeInputSats >= totalOutputSats + minerFee - existingInputSats`.
- `cmd/client/main.go` — the client adds a payment input (`tx.AddInputFrom(paymentTxID, …, paymentUnlocker)`) signed `0xC1`, i.e. the reference client already emits the shape a real wallet would.
- `internal/feedelegator/handler.go` (`POST /api/v1/tx`) — the *other* delegation API accepts `TxJSON` inputs **with explicit `satoshis`**, proving the request-format fix already exists in-tree.

## Root cause

Input values are not knowable from `partial_tx` alone, and the `/delegate/x402` request does not communicate them. The delegator therefore treats every output as its own obligation. The wire format itself is not the blocker: the gateway's template nonce signature is `0xC3` (`SIGHASH_SINGLE | ANYONECANPAY | FORKID`), which already permits client-added inputs *and* client-added outputs (change) without invalidating the pre-signed nonce.

## Why this matters

x402's economic premise is that the **client** pays for the resource. Under the current delegation model the merchant funds every settlement itself, which is fine for a subsidized demo but cannot back a real merchant, and it blocks independent wallets from making real payments. Separately, the spec's exact-value-conservation rule ("any remainder MUST be represented as a change output when ≥ 1 sat") cannot be honored client-side: a client that adds change breaks the delegator; a client that doesn't burns the remainder as fee.

## Suggested paths

- **A. Carry client input values in the request.** Reuse the `TxJSON` shape from `/api/v1/tx` (inputs with `satoshis`) or add an `input_satoshis` map to the `/delegate/x402` request. The deficit loop then credits client inputs and leases pool UTXOs only for the fee. Smallest change; client attestation of values is verifiable on-chain after broadcast.
- **B. Delegator resolves input values on-chain.** Look up non-pool input outpoints via a chain source. Heavier (network reads, caching, failure modes), but keeps the request format frozen.
- **C. Spec clarification.** Define Profile B explicitly as *gateway-sponsored settlement* (demo mode) and specify a client-funded profile with the request schema for input values, change handling, and the value-conservation rule applied per party (client remainder → client change; pool remainder → delegator change).

We implemented the client side of A in Dogfood (partial builder: nonce input preserved at index 0 with the template script intact, payment inputs signed `0xC1`, client change at output index ≥ 1, smallest-first coin selection) and are happy to run conformance checks against any candidate fix.

## Additional field note (fee policy)

Settlement transactions built with the reference 1 sat/KB fee config (~1–3 sats total) are rejected by GorillaPool ARC (`465 fee too low`, minimum ~34 sats for these sizes) but accepted by WhatsOnChain's relay. Your composite broadcaster's ARC→WoC fallback handles this; independent implementers should note that ARC alone will refuse v1 settlement txs at the default fee rate. Client-funded settlement (path A/B) also fixes this organically: the client's fee contribution can meet ARC policy without depending on relay leniency.

---

*Reported by the Dogfood Wallet project — happy to provide the full probe transcripts, raw transactions, and a test harness.*
