# Payment holds and human forensic recovery

## Scope (not an all-wallet transaction manager)

`sendPayment` (CLI/MCP send) and shared `payX402` (CLI `x402-pay`, MCP
`x402_pay`, BSV/Base/Solana), and `delegateX402` (CLI `x402-delegate`, MCP
`x402_delegate`), plus owner-only `splitPayment` (CLI `split`) and
`fundAllowance` (CLI `allowance-fund`), and owner `fundBridge`
(CLI `bridge-rebalance`), share one
per-vault exclusive `payment.lock`.
It is acquired using exclusive filesystem creation **before** loading policy
and usage; contenders fail immediately with `PAYMENT_HELD`, without signing
or network calls. No queue, PID probing, lock timeout or stale-lock removal.

Before signing, `payment.pending.json` records a unique payment ID, operation,
UTC start, asset, amount, payee and BSV fee where available. It contains no
private key, raw signed transaction, authorization, response body or URL.
Both files are flushed with fsync. Successful accounting is appended and
fsynced to `spends.jsonl` with `paymentId` before pending/lock removal. Existing
per-asset usage and policy/allowlist/BRC-181 gates remain in force; only
`UNSUPPORTED` permits rail fallback. Base/Solana orchestration requires a
positive settlement receipt and transaction identifier, not HTTP success alone.
These receipts remain merchant assertions, not independent chain proof.

Failures before reservation release the lock normally. Any exception after
reservation (including signing failure, rejected/ambiguous submission,
response-body failure, or failed log commit) leaves it held. Process death
leaves even a pre-sign lock held. Empty, malformed, orphaned or unreadable
state fails closed. A crash after log commit can leave a hold alongside an
already-counted spend; it must **not** be counted again blindly.

Read-only operations and `kill` remain available. Owner `sweepPayment` and
`sweepAllowance` remain available
for emergency recovery, bypassing the hold as it bypasses policy caps/kill.
Stop **all spenders** before sweeping: this is not cancellation of an in-flight payment.

## Owner split (self-send, not a transfer)

Split acquires the same guard before loading the vault/policy, honors kill,
and continues to ignore agent caps, allowlist and BRC-181. Each input must
match its source transaction hash, output index, value and vault P2PKH script;
duplicate outpoints and unsafe totals are refused before signing. These checks
do not independently establish that an output remains unspent on chain.

The version-1 intent adds only operation `split`: asset must be `bsv`, amount
must be **0**, destination is the vault address, and fee is required. There is
no arbitrary-script destination support. The miner fee is verified input total
minus the self-output total, not a fabricated transfer amount or cap debit.
Before signing, this intent is flushed. A matching broadcaster txid and exactly
one fsynced `kind: "split"`, `amount: 0` row with `paymentId` are required before
release. Daily/lifetime usage excludes split, including its fee. Ambiguous
broadcast, mismatched acknowledgement, signing/log failure and process death
retain the hold just as for agent sends. When reconciling a split, preserve the
zero transfer amount and record the fee separately; never charge self-outputs
as an outgoing payment or append a duplicate row after a post-log crash.

## Legacy delegation boundary

CLI/MCP delegation acquires the same guard before vault policy/usage reads.
Client-funded intent is flushed immediately before signing. Merely returning a
proof does **not** establish payment: forwarding a signed partial exposes funds
regardless of local `broadcast=false`. That mode returns `PAYMENT_HELD` without
a success proof or spend row. The remote party can still broadcast it. Reconcile
it like any ambiguous authorization; do not retry or infer non-payment.

Guarded funding currently supports one UTXO with positive change. It uses
ALL|FORKID|ANYONECANPAY (0xC1), binding **all** payee/change outputs, not the
legacy SINGLE (0xC3) signature which binds only its paired output. Fee sponsors
may append inputs only. Multi-input/exact-value funding and delegator-added
outputs are deliberately unsupported at this boundary. A sponsor requiring
its own change output is incompatible; do not bypass the guard to use it.

Before release, validate exact completed txid/serialization, header nonce,
payee, preserved client inputs/outputs, source transaction hashes/values/scripts,
all input scripts/signatures, no duplicate or additional local inputs, exact
vault debit, and matching successful broadcaster acknowledgement. Append and
fsync exactly one BSV accounting row with `paymentId`. This is zero-conf
broadcast evidence, not independent chain confirmation or an unspent-set proof.
Rejected/ambiguous delegation, invalid completion, mismatched broadcast ID,
signing/log failure or crash after reservation leaves the hold intact.

Sponsored mode takes the exclusive lock but does not reserve local spending,
sign, or account a vault debit. Check supplied template sources before forwarding
so an alleged sponsor cannot send local signed inputs around the intent step.
Validate completed transactions too. Pure sponsored network failures can release
normally because no local authorization was produced; process death still
leaves an orphan lock. Neither mode bypasses an existing hold.

MCP stdio and HTTP use the same registry: `address`, `status`, `balance`, `send`,
`kill`, `x402_inspect`, `x402_proof`, `x402_delegate`, `x402_pay`. All three
payment tools use the guard; inspect/proof do not sign or submit transactions.
No hold-clear tool is registered.

**Excluded:** direct `settleX402`/`buildClientFundedPartialTx` library calls
without guarded orchestration, raw `sendRaw`, allowance sweeping, owner sweep, fee delegator and
merchant replay state. Direct library rail calls without the orchestration
callbacks are also outside the guard. Do not run excluded spenders concurrently
with guarded payments or use them to bypass a hold. This is not cross-wallet,
distributed, or adversarial-filesystem protection.

## Bridge order-only quarantine

Legacy `bridge.intent.json` / `bridge.order.json` records remain quarantined and
are never silently migrated or funded. The old order-only library helper remains
available for inspecting that bounded behavior, but it is not the current CLI
funding path.

The current owner-only CLI funding/reconciliation lifecycle is described in
[bridge-lifecycle.md](bridge-lifecycle.md). It uses append-only intent/order/signed
transaction/accounting evidence and a separate durable parked-exposure witness.
Funding can relinquish its own execution lock while retaining pending exposure;
all ordinary guarded spenders remain blocked. Reconciliation acquires its own
exclusive lock and never takes over a live or abandoned one. It checks the exact
provider order plus independently confirmed BSV and finalized Base USDC receipt
logs before accounting/release. The receipt must be strictly newer than the
pre-order Base boundary, whose chain/number/hash is persisted before creation
and checked for canonical consistency during reconciliation, including recovery
after completion-marker persistence. Missing historical boundaries cannot be
inferred or backfilled safely; leave that exposure held. Provider attribution
of deposit/order/payout remains trusted, not independently proven by those
logs (see the lifecycle trust model). Status remains local/read-only. Neither command
is on MCP. Process-crash locks, corrupt accounting and unresolved evidence remain
held, with no automatic expiry, retry, broadcast replay or force-unlock.

## Allowance funding lifecycle

`fundAllowance` takes the shared lock before archive, policy and usage reads.
It retains amount-cap and kill gating; owner script funding still intentionally
ignores the destination allowlist (including an empty allowlist) and BRC-181
agent-send policy. BRC-204 locks, Type42 derivation and BRC-52 certificate
issuance/revocation binding are unchanged. Caps charge the allowance amount;
the one-sat revocation and actual miner fee remain separate, as before.

The bounded state sequence is:

1. Validate saved state, then policy and selected source transactions. Verify
   source txid, output index/value, vault P2PKH script, unique outpoints and safe
   integer totals. This does not independently prove inputs are still unspent.
2. Fsync the ordinary non-secret payment intent (`operation: allowance-fund`,
   asset BSV, allowance amount, vault address, actual fee) **before signing**.
3. Sign, compute the funding txid, issue the certificate, then exclusively create
   and fsync `allowances/<txid>.json`: version 1, txid, signed rawHex, amount, fee
   and the full descriptor including certificate, revocation and masterKeyring.
   No broadcaster call occurs before that file is durable. Files request 0600;
   the new directory requests 0700. These are **private recovery artifacts**, not
   public descriptors. Protect Windows vault directories with appropriate ACLs.
4. Require the broadcaster's returned txid to exactly match the signed txid.
   Append/fsync one `allowance-fund` accounting row with the guard's paymentId.
5. Exclusively create/fsync `<txid>.accounted.json` containing version 1 and txid,
   then allow the guard to remove pending/lock. Marker failure after accounting
   deliberately retains the hold: the spend may already be counted.

Failures at/after reservation retain the shared hold, including certificate or
record persistence failures before broadcast. Process death at the record
stage or after broadcast/accounting retains signed identification and recovery
metadata. If death precedes durable record creation, the intent/lock remains,
but no broadcaster has been called by this path; missing record contents are
never invented. A partially written record is corruption, not permission to
continue. An ambiguous broadcaster failure retains the full pre-exposure record
and never logs inferred success or returns a success descriptor.

Every new funding is a new allowance, **not an idempotent retry API**. An unresolved
archive blocks further funding even if someone incorrectly removes the payment
hold. Completed archives require exactly one matching amount/fee/BSV accounting
row with paymentId before another funding can start; missing/duplicate/conflicting
accounting is not repaired automatically. Other guarded operations rely on the
shared hold, not on scanning the allowance archive: deleting a hold to bypass it
is unsupported. No automatic reconciliation, replay or hold-clear command exists.

### Legacy and owner selection

`allowance.json` remains read-only in place, under record ID `legacy`. No new
funding writes that filename, and no automatic migration or accounting inference
is made for it. Older valid descriptors without certificates remain readable;
only available historical metadata can be preserved. Earlier descriptors already
overwritten by old binaries, missing certificates/keyrings and unknown chain
outputs cannot be manufactured. Do not mix old and new binaries on one vault.

`allowance-list` emits only record ID, local status, txid, allowance ID and amount;
it does not decrypt the vault key or contact a provider. `accounted` means a local
completion marker, **not** current unspent status or independent chain settlement.
Malformed inventory fails closed with a sanitized error, not raw file contents.
The raw private records can be reviewed locally by the human owner, never pasted
into agent chats, stdout or MCP. The allowance commands remain owner-only.

With multiple records the default sweep refuses; use
`allowance-sweep --record <funding-txid> [p2pkh-address]`, or `--record legacy`.
Explicit selection validates only that descriptor/record, allowing emergency
recovery despite an unrelated broken record or completion marker. It verifies
owner identity and fetched source hash/index/value/derived scripts before
signing, and checks the returned sweep txid. It does not delete records, rewrite
receipts or clear any hold. The existing sweep is not itself crash-journaled or
idempotent; a second sweep can fail on spent inputs and must not be retried after
an ambiguous acknowledgement. Partial agent consumption is not handled by this
all-listed-outputs sweep. Independently reconcile and use specialist owner
recovery if some outputs are already spent. **Stop all spenders first**, including
external allowance agents: a sweep is not cancellation of their authorizations.

### Manual allowance reconciliation limits

Preserve private records together with lock/pending and accounting evidence.
Correlate the signed funding txid, each allowance output, revocation and actual
chain/broadcaster evidence. Do not rebroadcast merely because a receipt/log is
missing. Verify accounting exactly once by paymentId and txid; a crash after log
fsync must not add the amount a second time. No recovery writer is shipped. A
human independently reconciling a settled funding may repair durable accounting
and its completion marker only after validating all evidence and stopping every
spender; never treat creating a marker as settlement proof. Unsubmitted or
unresolved records cannot be marked accounted just to enable funding. Retain
unresolved evidence/holds and use emergency owner recovery instead. A definitive
nonsettlement resolution needs a separately reviewed archive/recovery procedure;
this slice intentionally favors a persistent hold over guessing.

Missing/rolled-back state and noncooperating old binaries remain outside the
protection model. File fsync is mandatory, but the Windows directory-entry/power
loss limitation below applies to these records and completion markers too.

## Inspect without unlocking

With the intended `DOGFOOD_WALLET_DIR` explicitly selected:

```
bun src/cli.ts payment-inspect
```

This command does not decrypt the vault, fetch network data, mutate state or
clear anything. It reports lock presence, pending schema validity, and only a
validated payment ID/asset/amount. No generic clearing mutation is exposed
through MCP or CLI. Bridge-only owner reconciliation is described above. `PAYMENT_HELD` deliberately does not distinguish a live
process from an abandoned lock.

## Manual forensic procedure — human owner only

1. Set the killfile with `kill`. Stop **all** CLI, MCP, HTTP, background agents
   and other spenders using this vault; verify none can resume. Never unlink a
   live lock. Preserve secure copies of lock, pending, spend log, relevant
   process/merchant evidence and policy. Do not share key files.
2. Inspect the record and independently reconcile the attempted payment with
   the merchant/facilitator and the relevant chain/account history. Correlate
   payee, amount, asset, time and any transaction/authorization evidence. The
   pending record intentionally cannot reconstruct or replay a signed payment.
   A timeout, old timestamp, absent log row, dead PID, unchanged displayed
   balance or rejected HTTP response is **not proof of non-payment**. An EVM
   authorization may remain exercisable after a request fails.
3. If settled, verify durable accounting exists **exactly once** for this
   `paymentId` and asset, with the actual settlement time and transaction ID.
   If missing, a human must repair/flush the spend log from independently
   validated evidence before considering release. Inspect partial/torn writes;
   the historical log parser skips malformed lines. Do not subtract exposure
   or clear based on an unverified assertion.
4. If definitely unsubmitted/nonsettled and no signed authorization remains
   exercisable, document the independent evidence. If certainty is unavailable,
   **leave the hold and killfile in place**; seek merchant/chain reconciliation
   or recover funds using owner controls. No automated reconciliation is shipped.
5. Only after that review, while every spender remains stopped, an owner may
   archive the resolved pending/lock files outside their active filenames,
   retaining the evidence and decision. This is a deliberate manual filesystem
   administration step, not a wallet reset command. Re-run inspection and
   review per-asset accounting before separately deciding whether to remove
   `STOP_SPENDING` and restart agents. Never do this by elapsed time alone.

## Durability and verification limits

Cooperating processes on the same local filesystem are covered. `fsync` is
mandatory for created lock/intent and appended log files. Directory fsync is
also required on non-Windows platforms; Node/Bun Windows cannot open directories
for it, so full directory-entry ordering through abrupt **machine power loss**
is not guaranteed there. Process-crash/restart persistence is tested on Windows;
no power-cut or NFS/distributed-filesystem claim is made. Removing/rolling back
both state files, log tampering, copied vaults and noncooperating old binaries
are outside this mechanism. Holds are deliberately availability-conservative.

Tests use generated unfunded disposable vaults, real filesystem/subprocess
exclusion and intercepted network. They do not demonstrate mainnet settlement.
