# Owner approval packet: one direct BSV payment

**Proposal only — no wallet selected, destination verified, funds inspected, or
payment authorized.** This packet prepares one owner-operated CLI `send` on BSV
mainnet, not x402, a bridge, delegation, an allowance, MCP automation or a self-send.
It complements [quickstart](quickstart.md), the
[whole-vault backup procedure](backup-rehearsal.md#owner-procedure-for-a-real-backup-manual-separate-from-this-script)
and [forensic recovery](payment-recovery.md#manual-forensic-procedure--human-owner-only);
it does not replace those guides or repeat their rehearsal.

## Proposed limits and the fee-enforcement gate

| Item | Proposal, not authorization |
|---|---|
| Recipient payout | **1,000 sats** to one independently verified recipient |
| Maximum miner fee | **500 sats** |
| Maximum outgoing debit | **1,500 sats**, payout plus fee; change stays in the vault |
| Execution allowance | One CLI invocation; no second attempt under this approval |
| Funding | Existing owner-selected persistent vault only; no treasury assumption |

`src/send.ts` selects smallest UTXOs first and estimates the fee as
`10 + 148 * inputCount + 34 * 2` sats: one input costs 226, two 374, three
522. Change of zero or one sat is omitted (one sat is added to the fee);
change greater than one sat is returned. A 500-sat ceiling accommodates at most
two selected inputs at this formula; fragmentation can block the proposal.
This is the current code's fee calculation, not a live miner quote or guarantee
of acceptance. Direct `evaluateSend` requires a positive safe integer, not the
1,000-sat floor used by **split**. The proposed payout avoids a tiny payment;
no claim is made about universal dust/relay rules or the acceptability of tiny change.

Use the explicit `send ... --max-fee <approved-fee-sats>` flag for this packet.
The proposed ceiling is `--max-fee 500`. The API validates a finite nonnegative
safe integer before vault/funding access; the signer checks **source-validated
input total minus all outputs**, including omitted change, before reservation,
signing or broadcast. Equality is accepted; over-cap refusal leaves no new hold
or spend row. Ordinary local policy caps charge payout, not fee.

Any existing signed `brc181.json` remains mandatory and is ANDed with local policy
and this explicit ceiling. Its destination, origin, per-tx/destination caps, fee
cap and remaining cumulative `total_budget` must also permit the payment. The
stricter fee ceiling wins. Its cumulative budget includes payout plus fees for
ordinary/legacy BSV and bridge-BSV usage; do not reset history to gain headroom.
A signed policy is **not required solely to add this one-send fee ceiling**.
If an existing envelope is invalid or incompatible, stop: do not edit its signed
payload, remove it, substitute a sample or invent a CLI issuer. Policy provisioning
or mutation requires separate review and permission; this flag never changes it.

The approved exact payout plus enforced fee ceiling bounds this one debit. There
is no `--budget`, `--dry-run`, preview or interactive confirmation flag, and no
single-use approval token. Omitting `--max-fee` adds no new ceiling and is **not
acceptable for this bounded packet**. A balance snapshot is not a hard fee cap.

## Owner preflight (only after permission for the selected wallet)

1. Record the exact persistent vault path, independently retained public source
   address, repository revision, operator, approval reference and expiry. Never
   select a scratch/rehearsal vault or initialize a replacement. Keep keys,
   wrapping material, origin tokens and private recovery artifacts out of chat,
   command arguments and shared evidence.
2. Stop all CLI/MCP/HTTP agents, schedulers, policy writers and external spenders;
   prevent restart. Never activate a restored copy alongside its source. Make and
   verify a protected, independent whole-directory backup with hidden files and
   current accounting/recovery state, following the linked owner procedure.
   Any killfile setting/removal or recovery mutation requires separate permission;
   keep all other spenders stopped throughout acceptance.
3. From the repository root, after replacing the placeholder with the approved
   absolute path, these are the supported **offline read** commands:

   ```bash
   export DOGFOOD_WALLET_DIR='OWNER_SELECTED_ABSOLUTE_PERSISTENT_VAULT_PATH'
   bun src/cli.ts doctor
   bun src/cli.ts payment-inspect
   bun src/cli.ts address
   bun src/cli.ts status
   ```

   Require the intended root and matching independently retained source address,
   complete initialization, intact current policy/accounting, no unresolved hold
   or parked exposure, and no killfile at execution. Doctor is metadata-only;
   address/status decrypt the local key. None proves funding or settlement.
   Owner-local review must also validate the explicit fee flag, any signed policy and current
   daily/lifetime headroom. Missing/unrestricted policy is not acceptable for this
   packet: require an explicit restricted allowlist containing the approved payee.
4. Independently obtain the full destination from the recipient's authenticated
   BSV receive screen/invoice, then confirm it through a separately trusted contact
   channel. Record recipient identity, evidence reference, time, exact address,
   BSV mainnet and agreed payout. Validate Base58Check/network and P2PKH type with
   a trusted wallet; the local regex check alone is insufficient. Compare every
   character, not just prefix/suffix. Require destination different from source;
   a self-payment does not demonstrate external receipt. Do not invent an address.
5. Only after separate approval for online reads, `bun src/cli.ts balance` queries
   WhatsOnChain. Independently review current spendable source outputs and fee
   headroom; balance alone is insufficient. If unfunded or fragmented beyond the
   ceiling, stop. Funding from a named owner-controlled source, its own fee budget,
   initialization, splitting or consolidation are separate decisions, not implied
   by this payment approval. Do not access the shared treasury.

If allowlisting is needed, the supported owner-only syntax is
`bun src/cli.ts allow 'OWNER_VERIFIED_P2PKH_ADDRESS'`, **only with separate policy
mutation permission**, writers stopped, and subsequent policy readback. It adds
a destination; it does not authorize this payment or narrow an already broader
list to just that destination. Manual policy edits and signed-policy issuance are
separate operations. Do not change caps merely to force success.

## Execute once, only after explicit final approval

The reference syntax is `bun src/cli.ts send <to-address> <sats> --max-fee <approved-fee-sats> [note]`.
For the unchanged proposal, the payout token is `1000` and fee flag is `--max-fee 500`.
The fee token must be separate decimal digits, a nonnegative safe integer; missing,
duplicate or malformed options are rejected, not logged as notes. Use `--` before
literal note tokens beginning with `-`; the fee flag must precede this separator.
The operator substitutes the approved full address, payout and fee ceiling only after
all gates pass. The optional note may contain a nonsecret approval reference;
it is neither an idempotency key nor recipient evidence. **This command signs and
broadcasts immediately.** No executable send script is supplied by this packet.

Network behavior is part of the approval: source UTXOs/raw transactions come
from WhatsOnChain; broadcasting uses GorillaPool ARC. The existing broadcaster
can submit the **same signed bytes** to WhatsOnChain when its error-message
classifier sees a fee-policy rejection (`fee` plus `too low`, `insufficient`,
`465` or `461`). This built-in fallback is not a second payment or a manually
authorized retry; it is not configurable by a `send` flag. Other errors are
terminal. If the owner disallows this existing fallback, do not execute this rail.
Never rerun the command, manually rebroadcast, increase the fee or switch rails
because the result is missing, rejected, delayed or ambiguous.

## Evidence, acceptance and stop conditions

Keep a sanitized record of the approval, preflight decisions, invocation time,
exact recipient/amount, returned txid and actual fee. After execution, independently
inspect the transaction's source outputs, recipient output(s), change and fee;
require the exact approved payout, fee within ceiling and debit within budget.
Correlate exactly one durable `spends.jsonl` row with txid and `paymentId`, then
use `payment-inspect` to check hold state. Do not share the whole vault or raw
private recovery records as evidence.

Obtain recipient confirmation through the trusted channel, identifying txid,
address and exact sats received. Independently record mined block hash/height
and at least one confirmation from a chain source, with observation time.
CLI success/ARC acknowledgement is only broadcast evidence: while unmined or
recipient confirmation is missing, report acceptance **pending**, not complete.

On any error, disagreement, timeout, missing row or retained hold, stop the
acceptance with **no retry**, even if a failure appears pre-sign. Keep all spenders
stopped and preserve existing lock/pending/accounting and private evidence.
An absent log/txid, unchanged balance or explorer miss does not prove non-payment.
The ordinary send intent does not preserve raw signed bytes/txid for replay.
Follow the linked forensic procedure to reconcile chain and recipient evidence
and accounting exactly once. Hold clearing, log repair, killfile changes, sweep,
refund, rebroadcast or another payment each need separate owner permission;
no automatic reconciliation or ordinary-send reconcile CLI exists.

## Single owner approval request (fill every field; blanks mean not authorized)

> Please select the existing persistent vault **[absolute path + public source
> address]** and recipient **[identity + exact BSV mainnet P2PKH address + independent
> verification reference]**. Confirm or replace the proposal: **[1,000] sats payout,
> maximum [500] sats miner fee, maximum [1,500] sats total debit**. Do you authorize
> **[named operator]**, before **[expiry/timezone]**, to perform the selected wallet's
> offline preflight and online read-only funding/settlement checks, and then **one
> CLI direct send invocation only if every gate in this packet passes**, including
> the explicit `--max-fee` ceiling, any existing signed policy, and ARC-to-WoC
> same-transaction fee-rejection fallback?
> Record approval **[reference]** and the recipient-confirmation channel **[channel]**.
> This does not authorize funding, initialization, policy/allowlist edits, signed
> policy issuance, killfile/hold changes, split, sweep, retry or another rail.

An owner may authorize **preflight only** instead; that is not permission to send.
If a gate requires a mutation, pause for a separate narrowly scoped approval and
revalidate before the one-payment decision. No operational checks were performed
in preparing this document.

### Source verification

Updated for the direct-send fee-ceiling change on baseline
`2fa9e406dd617cef96cbc3756cdc38c92636f4bc`:
`src/cli.ts` (command parsing), `src/send.ts` (fee/source checks and broadcaster),
`src/policy.ts` (amount-only caps/address regex), `src/brc181.ts` (signed fee and
cumulative budget gates), and the linked recovery/backup docs. Re-review if the
code changes before execution. This artifact is an approval packet, not funded
acceptance evidence.
