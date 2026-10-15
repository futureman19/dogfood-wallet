# Owner bridge lifecycle (review implementation)

This code has **synthetic offline verification, not live provider compatibility or funded acceptance**. Provider schema sources and fixture provenance are in [bridge-provider-contracts.md](bridge-provider-contracts.md).

## Commands

- `bridge-quote <sats>`: estimate only.
- `bridge-rebalance [sats]`: owner-only. With no amount, retain the configured low-water / swap-size behavior. Uses the shared per-vault payment guard before policy/usage reads. A successful call deposits once and reports `awaiting-reconciliation`, not swap success.
- `bridge-status [orderId|intentId]`: local, read-only, sanitized evidence. Does not decrypt the vault, query a provider, book arrivals, or release holds.
- `bridge-reconcile <intentId>`: explicit owner-only reconciliation. No signing or broadcasting. Neither bridge command is an MCP tool.

A bridge policy must already have been deliberately enabled by the owner. This implementation does not create or edit real configuration. Bridge caps include the deposit fee; arrival rows use `bridge-usdc-base`, not ordinary USDC spend usage. BRC-181 gates remain applied to the deposit. Emergency sweep remains unchanged and does not erase history or holds.

## Evidence and exclusion

`bridge-records/<intentId>/` is append-only, with exclusive files for intent, validated order, signed transaction plus public source transactions, broadcast acknowledgement, exact outgoing/incoming accounting rows, and completion. No keys or provider response bodies are copied into these records. Signed transactions are spend-capable evidence: protect the vault directory.

Immediately before creating an order, the pinned Base RPC is checked for chain ID 8453 and its **latest** block number/hash is read, then re-read by number for canonical consistency. Latest (not finalized) deliberately excludes even pre-existing unfinalized transfers. This `baseBoundary` is fsynced in `intent.json` before the provider POST, signing, or broadcasting. Retrieval/validation failure occurs before reservation/provider exposure; it cannot create an order or sign. Missing legacy boundaries are not reconstructed from current chain state.

A durable pending intent precedes the provider POST. Signed bytes are persisted before a **single** ARC broadcast; the bridge intentionally does not use the generic fee-fallback broadcaster. Source transaction IDs, amounts, ownership scripts, signatures and output/fee conservation are validated. Ambiguous POST/broadcast/persistence outcomes keep the hold; retries cannot deposit again.

Execution identity and unresolved exposure are distinct:

1. `payment.lock` exclusively identifies the live operation.
2. `payment.pending.json` identifies the bridge exposure.
3. Once the callback has stopped performing funding work, `payment.bridge-parked.json` durably witnesses the same exposure identity; only the owning execution releases its own lock. Pending exposure continues to block every ordinary guarded spender.
4. Reconciliation must acquire a **new exclusive** execution lock and match both durable identities. It never unlinks, steals, times out or takes over another process's lock. A process killed while holding an execution lock deliberately requires forensic recovery; `bridge-reconcile` does not automatically unlock it.
5. Completion and exact-once accounting precede removal of the exposure witnesses. Interrupted partial deletion remains held; there is no PID/time-based recovery.

## Chain settlement checks and provider attribution

Provider status must match the exact recorded provider/order, BSV deposit address/amount, own Base pocket, deposit txid, and a finished state. The provider does not prove arrival.

The pinned BSV **mainnet** WoC URL independently supplies the exact recorded raw transaction and matching txid with at least one confirmation and a block hash. The stored source transactions/signatures and deposit/change/fee conservation are revalidated.

At reconciliation the persisted boundary must be well formed, chain 8453, and still canonical by number/hash. Receipt inclusion must be **strictly newer** than that boundary (same-block payouts are conservatively refused), including on completion-marker crash recovery before releasing restored pending exposure. A missing, malformed or forked boundary keeps the hold; never replace it with a new boundary to unblock an old intent.

The pinned Base RPC must report chain ID 8453, a successful receipt for the provider's exact payout transaction, a canonical block hash, at least 12 blocks of inclusion, and a finalized block at or beyond inclusion. Only native USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` Transfer logs to the exact pocket count. Log transaction/block identities, topics, data, removal flags and unique indices are checked. The actual sum must exactly equal the provider's actual payout amount; the estimate is never booked as an arrival. Other tokens/chains or a plain balance increase cannot qualify.

**Residual order-attribution trust:** the provider still asserts which payout hash and actual amount belong to this deposit/order. A native USDC Transfer contains no provider order ID or BSV outpoint. Matching a recent, unused transaction to our shared pocket does not independently bind it to this order: a dishonest provider could nominate an unrelated contemporaneous transfer. The boundary defeats historical replay, not this stronger attribution attack. The existing centralized-provider lifecycle therefore requires trusting the chosen provider for deposit/order/payout attribution. `complete` means chain-verified transfer plus provider-asserted attribution, NOT trustless cross-chain completion. Owner reconciliation is not proof of a cryptographic relationship.

There is no independently binding order/deposit commitment in the documented adapter schemas; do not invent one from `depositHash`, `payoutHash`, amount, or an explorer link. Where independent order identity is required, this provider mode cannot meet it: do not enable/fund it, and leave ambiguous exposure held for owner investigation. A future independently binding protocol or dedicated per-order recipient would require a separately reviewed design (including recovery/sweeping); this patch does not claim to implement it.

These checks trust the configured fixed public chain data services; they are not independently operated full-node/SPV verification. Later reorgs or RPC dishonesty are outside this local test proof.

Completed deposit and payout transaction claims cannot be reused by another intent. Repeated reconciliation is idempotent. A subsequent bridge can run only after all preceding records and their accounting are consistent and complete. Missing/corrupt accounting is not silently regenerated. A lost broadcast acknowledgement can be resolved only if independently verified signed evidence exists and no contradictory acknowledged accounting is present.

## Signed budget units and scopes

All BRC-181 budget values here are integer **BSV satoshis**, never USDC micro-units. The signed `total_budget` check is cumulative historical BSV `amount + fee`, plus the prospective payout and its fee exactly once. Ordinary send now also charges/logs a discarded one-satoshi change remainder as miner fee, matching the actual transaction debit. `usageFromLog(..., "brc181-bsv")` combines ordinary `bsv` (including legacy absent-asset rows) and `bridge-bsv`; bridge-in/USDC/Solana/unrelated assets are excluded. Historical missing fees contribute zero; negative/non-integer fee values are not counted. No estimated arrival or entire input/change total is treated as a debit. Existing malformed-line tolerance remains unchanged outside the stricter bridge journal validation.

The signed scope is wired through bridge funding, ordinary send (pre/post fee checks), shared CLI/MCP direct BSV x402, and guarded delegation. Low-level settlement APIs accept a separate `brc181SpentTotal`; vault-backed callers always supply the combined scope. Their existing caller-supplied ordinary usage fallback is retained for non-vault library compatibility. Client-funded delegation accounts the challenge amount, sponsor-paid fee zero; sponsored delegation keeps its pre-existing policy gating and does not add local accounting.

Local ordinary policy remains ordinary BSV principal-only; bridge local caps remain bridge principal plus fee only. Neither scope is silently merged. Sweep, split and allowance-sweep are excluded from signed usage. Owner `allowance-fund` already logs BSV principal and participates in historical usage; its recorded fee now also participates in the signed cumulative debit. It still uses `evaluateAllowanceFund`, not a new BRC gate: this change does not make it an agent payment or alter owner authorization. Allowance spending is not re-booked as a second vault debit here. Emergency sweep/self-split behavior and locks are unchanged.

## Deliberate limitations

- No automatic retry, refund, hold-clear, provider action/push, or broadcast replay.
- Pre-sign order-only ambiguity cannot be cleared by pretending it completed.
- Crashes during a live exclusive transition retain the execution lock. This is a conservative operational limitation, not an implemented force-recovery mechanism.
- Windows file fsync is performed, but directory fsync is unavailable through Node/Bun. Do not claim guaranteed power-loss durability of directory entries on Windows.
- Local exclusive-file exclusion assumes cooperative processes and a local filesystem. A hostile same-user process can modify files; coupled rollback/deletion of all witnesses cannot be detected without an external monotonic journal.
- Both adapters implement the retrieved v2 create/status field schemas. Pair availability, API-key entitlements, network-code acceptance and actual provider behavior still need separately approved live acceptance. No live transaction/API calls were made while implementing this branch.
