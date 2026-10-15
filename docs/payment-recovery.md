# Payment holds and human forensic recovery

## Scope (not an all-wallet transaction manager)

`sendPayment` (CLI/MCP send) and shared `payX402` (CLI `x402-pay`, MCP
`x402_pay`, BSV/Base/Solana), and `delegateX402` (CLI `x402-delegate`, MCP
`x402_delegate`) share one per-vault exclusive `payment.lock`.
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

Read-only operations and `kill` remain available. Owner sweep remains available
for emergency recovery, bypassing the hold as it bypasses policy caps/kill.
Stop agents before sweeping: this is not cancellation of an in-flight payment.

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
without guarded orchestration, raw `sendRaw` and bridge
rebalance, allowance funding/sweeping, split, owner sweep, fee delegator and
merchant replay state. Direct library rail calls without the orchestration
callbacks are also outside the guard. Do not run excluded spenders concurrently
with guarded payments or use them to bypass a hold. Allowance semantics are
unchanged. A follow-up must integrate those independently; this change does
not claim cross-wallet, distributed, or adversarial-filesystem safety.

## Inspect without unlocking

With the intended `DOGFOOD_WALLET_DIR` explicitly selected:

```
bun src/cli.ts payment-inspect
```

This command does not decrypt the vault, fetch network data, mutate state or
clear anything. It reports lock presence, pending schema validity, and only a
validated payment ID/asset/amount. No clearing/recovery mutation is exposed
through MCP or CLI. `PAYMENT_HELD` deliberately does not distinguish a live
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
