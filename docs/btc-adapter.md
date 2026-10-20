# BTC treasury adapter (human-only)

BTC receive/hold and deliberate owner sends, **not an agent spending rail**.
No BTC send is registered on MCP, x402 or the bridge. Existing Solana code is
unchanged. Human-only means owner CLI operation, not an interactive confirmation:
any process granted shell/vault access can invoke that CLI. Do not grant such
access to an untrusted agent.

## Identity and dependency

Derive the BTC private key exactly as `src/gryd-buy.ts`'s `propertyKey`, replacing
only the invoice domain:

```ts
rootKey.deriveChild(rootKey.toPublicKey(), "dogfood/btc/v1")
```

This is the SDK self-counterparty Type42 derivation, **not** SHA256(root bytes +
label), BIP32, a mnemonic path, or reuse of the BSV/EVM/property key. Preserve
this exact case-sensitive domain with your encrypted vault backup. Encode its
compressed public key as mainnet P2WPKH (`bc1q`). Only this address is queried
for funding; change returns here. Do not send BTC to the vault's BSV address.

The sole added direct dependency is the official **`@scure/btc-signer`** npm
package (2.4.1 in the lockfile; MIT), not an unscoped `scure-btc-signer` package.
It supplies native SegWit transaction construction/signing and mainnet address
checksum/network validation. BSV SDK still derives the key; its BSV transaction
signer is not used for BTC. Tests additionally verify SegWit ECDSA signatures
with the already-installed noble dependency.

Accepted destinations: base58check mainnet P2PKH/P2SH, bech32 v0 P2WPKH/P2WSH,
and bech32m v1 Taproot. Mixed-case, bad checksum, testnet and other witness
programs fail closed. Bech32 is normalized to lowercase **after** decoding;
base58 case is preserved. Both local `btc.allowlist` and BRC-181 destinations
are `btc:<canonical-address>`. Stored policy entries require canonical spelling:
missing prefixes and uppercase/mixed-case bech32 are rejected, never repaired.
The CLI still takes an unprefixed address and normalizes valid uppercase bech32
before matching the prefixed allowlist.

## Owner CLI and policy

```sh
bun src/cli.ts btc-address
bun src/cli.ts btc-balance
bun src/cli.ts btc-send <destination> <sats>
```

Select the intended vault explicitly with `DOGFOOD_WALLET_DIR`. `btc-address`
is offline; `btc-balance` prints JSON address plus `confirmed` and `unconfirmed`
UTXO sats. `btc-send` **signs and broadcasts by default**, printing only JSON
`txid`, `amount`, `fee` after matching acknowledgement. It accepts positive
safe-integer decimal satoshis only, no no-broadcast mode or automatic retries.
Receipt is broadcast acknowledgement, not mining confirmation.

Sending is disabled when `btc` is absent from policy.json. An owner may add a
block such as this (example only; not installed automatically):

```json
{"btc":{"maxPerTx":10000,"maxPerDay":50000,"maxLifetime":null,"allowlist":[],"maxFeeSats":1000}}
```

All fields are required; numeric fields are nonnegative safe integers. Only
`maxPerDay` and `maxLifetime` may be null (unlimited). Zero caps deny positive
sends. Empty allowlist denies all; null explicitly means unrestricted. Put
canonical prefixed BTC destinations in the list, for example
`"btc:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"` (public test-key example,
never fund). BSV `allow` does not edit this block.
Malformed present blocks fail closed. Stop all spenders before policy editing.

`evaluateBtcSend` gates amount, address, allowlist, per-tx/day/lifetime caps and
killfile. Local usage is `usageFromLog(..., 'btc')`, counting payout only;
actual fee is separately bounded by mandatory `maxFeeSats`. Installed BRC-181
is ANDed via `gateAgentSend` before signing and again before broadcast. Its
`brc181-btc` cumulative scope includes only BTC payout plus actual fees. Invalid
envelopes never permit fallback; existing rails retain their envelope gates.
BRC-181's pre-existing evaluator limitations (including expiry/rate windows)
are not changed by this adapter.

## Construction and transport

Only `https://mempool.space/api` is used:

* GET `/address/:address/utxo`
* GET `/tx/:txid/hex`
* GET `/fee-estimates`
* POST `/tx` (plain raw hex, one attempt)

Every call supports injected `fetchFn`, identifies Dogfood with a polite
User-Agent, rejects redirects, and has a 30-second deadline and bounded body.
No other explorer, alternate endpoint, fallback or broadcast retry exists.
The 6-block estimate is positive finite sat/vB; missing/invalid estimates deny.

Coins are selected smallest-first, with deterministic outpoint ties. Each
selected source's raw transaction hash, vout, amount and exact owned P2WPKH lock
must agree with the indexer. Use native SegWit SIGHASH_ALL inputs, version 2,
locktime 0, final sequences. No PSBT export or replace-by-fee workflow is added.

Fees use real P2WPKH weight: 41 stripped bytes/input, up to 108 witness
bytes/input for low-S DER signatures, 2 marker/flag bytes, CompactSize lengths
and exact destination scripts. Round weight / 4 up, then sat/vB fee up. Change
of at least 546 sats returns to self; smaller would-be change folds into the
actual fee and must still pass both fee caps. Actual finalized vsize/fee is
checked. This conservative estimate can exceed actual vsize slightly. There
is no spend-confirmation minimum: unconfirmed UTXOs are eligible. The centralized
indexer is trusted for unspent/confirmation status; this is not SPV validation
or protection against a spend racing the final check. Very small destination
outputs may be rejected by network dust policy; such rejection remains held.

## Durable holds and recovery

`withPaymentGuard(root, 'btc-send')` takes the shared vault lock before policy
and usage reads. It reserves asset `btc`, positive amount and nonnegative actual
fee before signing. The nonce-keyed `btc-sends/<paymentId>.json` is exclusively
created and fsynced before any broadcast, including signed raw bytes, txid,
derivation, source triples, fee/rate/vsize and change. These bytes are spendable
and private; no private key is recorded or printed.

Fresh UTXOs and kill/local/BRC policy checks happen both before reserve/sign
and **after evidence, immediately before broadcast**. Any post-reservation
failure leaves a valid pending hold. Timeout, HTTP rejection, redirect, response
loss, or wrong txid never triggers another POST or fallback. Subsequent sends
are blocked. Success fsyncs BTC accounting before releasing the hold.

Use offline `payment-inspect` and [payment recovery](payment-recovery.md).
Never delete holds, recreate intent or retry automatically; an owner must
independently reconcile exact evidence and chain settlement first. File fsync
is mandatory; Windows directory-fsync/power-loss and cooperative local-filesystem
locking limitations still apply. No new hold-clearing command is provided.

## Offline evidence

`testdata/btc-synthetic.json` freezes a public scalar-1 root, synthetic source
and exact signed transaction bytes. It has never been funded and is not a
mainnet receipt. Tests intercept **all** BTC transport, cover CLI and real MCP
absence/rejected invocation, policy/BRC caps, source validation, dust, fee math,
pre-sign and final UTXO/kill races, and ambiguous acknowledgement holds.
Run wallet tests only with a disposable scratch `DOGFOOD_WALLET_DIR` and
`TEMP`, `TMP`, `TMPDIR` set to the active-profile scratch directory. No live
network, real vault, broadcast or funds are required for verification.
