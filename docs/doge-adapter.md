# DOGE owner treasury

`doge-address`, `doge-balance`, `doge-send <destination> <koinu>` are owner CLI
commands. Send **broadcasts by default** and prints txid, amount and fee.
DOGE has 8 decimals: 100,000,000 koinu = 1 DOGE. No MCP send, x402 or bridge
integration. This is a shell/vault access boundary, not interactive human approval.

Backup the root secret and exact derivation: SDK
`root.deriveChild(root.toPublicKey(), 'dogfood/doge/v1')`. The compressed public
key makes P2PKH version `0x1e`. Destinations accept base58check P2PKH `0x1e` and
P2SH `0x16` only, preserving case; all bech32 is rejected. Installed
`@scure/btc-signer` uses a custom network (`wif:0x9e`; internal bech32 type field
is not an accepted format). Transactions are legacy, non-witness, SIGHASH_ALL.

## Enable deliberately

Absent `policy.json.doge` disables sends. Owner example (not installed):

```json
{"doge":{"maxPerTx":100000000,"maxPerDay":500000000,"maxLifetime":null,"maxFeeKoinu":1000000,"allowlist":[]}}
```

All caps and `maxFeeKoinu` are native integer **koinu**, never DOGE or BTC sats.
Empty allowlist denies; null is unrestricted. Add exact `doge:<base58address>`
entries; CLI destinations are unprefixed. Installed BRC-181 ANDs its destination,
amount, fee and cumulative budget rules with local policy; its numeric fee limit
is also koinu for DOGE. Local `doge` usage counts payout; `brc181-doge` counts
payout plus actual fee. STOP_SPENDING overrides both. Do not edit policy or run
other spenders concurrently.

## Provider and safety

Only `https://api.blockcypher.com/v1/doge/main` is contacted, keyless:
`GET /addrs/:addr?unspentOnly=true&limit=200`,
`GET /txs/:txid?includeHex=true`, `GET /`, `POST /txs/push` with `{"tx":"hex"}`.
Contracts: [official Address/TXRef/TX/push documentation](https://www.blockcypher.com/dev/bitcoin/).
Responses use `txrefs` / `unconfirmed_txrefs`; truncated/boundary-sized pages,
invalid/spent/duplicate refs and sums differing from `final_balance` fail closed.
Balance reports confirmed/unconfirmed **unspent output totals**, not a signed
unconfirmed balance delta. Missing empty arrays are allowed only when the total
still reconciles. Raw sources must match hash, index, value and exact own script.
**Mining/coinbase funding is unsupported, including mature rewards.** Any raw
source input with a null txid plus index `ffffffff` is rejected before reservation
or signing, regardless of API confirmation claims. Send rewards through an
ordinary transaction with another wallet before using them here. Balance remains
an unspent-output total, not a guarantee that every output is spendable by this rail.
Indexer trust remains; this is not SPV or a guarantee against concurrent spends.

The free budget is roughly 200 requests/hour and 3/second. Requests serialize
with >=350ms spacing and a process-local 190/hour ceiling that refuses rather
than automatically retries. Immutable source reads deduplicate within a send;
three fresh address reads are never cached. A send uses unique-source-count + 5
requests. Other processes/IP consumers and CLI restarts are not covered by this
in-memory budget: operate sparingly, one process at a time; HTTP429 fails closed.
Transport and timing are injectable for offline tests. No token, alternate host,
redirect following or POST retry exists.

Smallest-first selection uses conservative legacy byte size and
`max(medium_fee_per_kb, 1000000)` koinu/KB (0.01 DOGE/KB floor), **plus
1,000,000 koinu per spendable output below 1,000,000 koinu**. This additional
soft-dust fee is independent of byte rate and includes payout and change, not
just the recipient. Payouts below the unchanged **100,000 koinu hard dust**
threshold are refused. Only a remainder below 100,000 after the no-change
transaction's byte fee plus payout surcharge may be folded into the actual fee.

Selection evaluates the final output set: prefer non-soft change at or above
1,000,000. If provisional change is below that, subtracting its 1,000,000
surcharge makes it negative; if it is above, non-soft change is cheaper. Thus
this selector never needs to emit soft change. In the intervening fee gap it
adds another input or refuses insufficient funding, rather than oscillating
between thresholds or burning a soft-sized remainder. This is not a new hard
dust threshold: payouts of 100,000 through 999,999 remain supported with the
surcharge. The actual signed outputs and byte size are checked again. The full
fee (including any folded remainder) passes local maxFeeKoinu and BRC-181
fee/total-budget gates **before reservation/signing**. The example 1,000,000
fee ceiling above will intentionally refuse soft-dust payouts.

Read-only source basis, Dogecoin Core **v1.14.9**:
- [policy.h](https://github.com/dogecoin/dogecoin/blob/v1.14.9/src/policy/policy.h):
  `RECOMMENDED_MIN_TX_FEE = COIN / 100`, soft dust equals that value and hard
  dust equals soft / 10.
- [dogecoin-fees.cpp](https://github.com/dogecoin/dogecoin/blob/v1.14.9/src/dogecoin-fees.cpp):
  `GetDogecoinDustFee` adds `dustLimit` for each output strictly below it;
  minimum relay calculation adds this to its byte fee.
- [transaction.h](https://github.com/dogecoin/dogecoin/blob/v1.14.9/src/primitives/transaction.h):
  `IsDust` exempts unspendable scripts, otherwise compares `nValue < dustLimit`.
  This adapter emits only spendable P2PKH/P2SH outputs.
- [wallet.cpp](https://github.com/dogecoin/dogecoin/blob/v1.14.9/src/wallet/wallet.cpp):
  `GetRequiredFee` includes dust fees; Core's own creation flow rejects/discards
  below its wallet discard threshold. This adapter deliberately retains the
  requested 100,000 hard threshold rather than copying Core's discard policy.

This conservatively adds the fixed surcharge to the selected byte-rate floor;
node overrides and provider acceptance are not guaranteed by these defaults.
Fresh UTXOs, killfile and both policies are checked before signing and again
before broadcast; policy is rechecked after throttle immediately before POST.

The shared exclusive payment guard reserves positive amount plus fee before
signing. Private nonce-keyed `doge-sends/<paymentId>.json` evidence is exclusively
created and fsynced before POST. Ambiguity or post-sign refusal retains the hold;
a second invocation cannot retry. Never clear holds blindly: stop spenders,
inspect signed evidence, reconcile chain/accounting independently and follow
[recovery guidance](payment-recovery.md). Windows directory-fsync/power-loss
limitations apply. Synthetic public-scalar vectors, intercepted CLI and actual
MCP rejection tests prove local behavior, **not live acceptance or settlement**.
