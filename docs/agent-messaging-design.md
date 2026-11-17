# Agent-to-Agent Messaging — v1 Design

**Status: DESIGN ONLY — not implemented.** No code, policy schema, or MCP
surface described here exists yet. This document is the scoping artifact for
the feature; implementation follows the slices in §11 under the repo's TDD and
verification gates.

## 1. Purpose

Let one Dogfood vault (an agent) send a message to another vault (another
agent) that is **stored permanently on the BSV blockchain**, with
cryptographic proof of which vault key sent it.

Dogfood today lets agents *pay* (send, x402, bridge, OSP paid grants) and
*attest* (owner-only signed observations). It does not let agents *talk to
each other*. Messaging adds the coordination layer: agents can negotiate
terms, request access, and hand off tasks on-chain, then settle with the
payment rails that already exist.

Product fit: GrydWorld is a world for agents; Dogfood is its payment layer.
An agent that can message another agent can also compose
`message → negotiation → OSP paid grant / x402 / send` into cross-agent
commerce without any hosted intermediary.

## 2. Alignment with recent OSP work

The Open and Shut Protocol door-ownership slice (commits `16af988`,
`c5ff067`, `8963a00`) is the natural counterpart to this feature:

- **OSP gives agents on-chain doors**: one spend = authorization + payment +
  receipt (OSP-0005 paid grants). Grants carry an exact canonical scope blob
  (OSP-0002), a session pubkey, expiry height, and egress cap.
- **Today's grant negotiation is same-vault only.** `request_osp_grant` lets
  an agent file an ask into *its own owner's* escalation queue; the human
  approves and the CLI signs the exact bytes. There is no channel for
  **agent A to ask agent B's owner** for a grant on B's door.
- **Messaging is that channel.** A sends B an `osp.grant.request` message
  carrying the exact scope bytes and A's session pubkey. B's agent validates
  and files it into B's own queue via the existing `request_osp_grant` path.
  B's human approves; the existing signer broadcasts the paid grant; B sends
  A an `osp.grant.receipt` message with the grant txid; A verifies on-chain.

The human-approval invariant is untouched: messages never sign grants, never
widen scope bytes, and never bypass the queue. OSP's "nothing can be widened
after the human decides" property extends across vaults because the scope
blob travels byte-pinned inside a signed message.

Shared doctrine reused verbatim: policy gate before key/chain access,
fail-closed when the policy block is absent, killfile wins, fee-inclusive
caps, shared payment guard, fsynced intent/evidence before broadcast,
single-attempt ARC, ambiguous acknowledgement = HOLD (never auto-retry).

## 3. Existing primitives reused

| Primitive | Location | Reuse |
|---|---|---|
| Canonical JSON (JCS subset: sorted keys, no floats, safe integers, lowercase hex) | `src/osp-scope.ts` | Envelope canonicalization — same discipline as OSP-0002 scope blobs |
| BSM signing / keyless verification | `src/auth-sign.ts` | AIP `BITCOIN_ECDSA` signatures; verification needs no vault key |
| Shared payment guard, persisted intent, fsynced evidence, single-attempt broadcast, HOLD | `src/payment-guard.ts`, `src/send.ts`, `src/utxo-treasury.ts` | The message broadcast is a guarded spend like any other |
| Policy engine + usage accounting | `src/policy.ts`, `src/vault.ts` | New `messages` block and `messages` usage scope |
| BRC-181 envelope gates | `src/brc181.ts` | If installed, gates the notification destination + total |
| Escalation queue (`osp-grant` ask kind) | `src/requests.ts` | Receiving agent files cross-agent grant requests through the existing validation |
| WoC read helpers (paced, read-only) | `src/send.ts`, `src/osp.ts` | Inbox scan and receipt verification |
| OSP codecs + golden vectors | `src/osp-envelope.ts`, `testdata/osp-vectors.json` | Byte-pinning pattern for the message codec's own vectors |

No new runtime dependency is required: BitCom pushes are plain script
pushdata constructible with the existing `@bsv/sdk`. (`@1sat/templates` is
an optional convenience, not a requirement; adding it would need the
dependency-declaration gate in `scripts/package.test.ts`.)

## 4. On-chain format

### 4.1 OP_RETURN layout (BitCom B | MAP | AIP)

One OP_RETURN output, chained per the BitCom convention so ecosystem
indexers (JungleBus, 1Sat tooling) can parse and verify it natively:

```
OP_RETURN
  | B_PREFIX                              (19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut)
  | <envelope>                            (UTF-8 canonical JSON, §4.2, single push)
  | "application/json"
  | "utf-8"
  | MAP_PREFIX                            (1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5)
  | "SET"
  | "app"  | "dogfood"
  | "type" | <message type>               (§6)
  | "to"   | <recipient vault address>
  | AIP_PREFIX                            (15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva)
  | "BITCOIN_ECDSA"
  | <sender vault address>
  | <base64 signature>
```

- **AIP signing semantics are strict AIP**: the signature is computed per the
  AIP spec over the preceding OP_RETURN pushdata, so third-party AIP
  verifiers (JungleBus/bmap-family) validate it without Dogfood-specific
  knowledge. Exact byte rules are pinned to golden vectors at implementation
  time (slice S1), sourced from the AIP spec and observed indexer behavior.
- **Domain separation** comes from the signed content itself: `app`, `v`,
  `type`, `from`, `to`, `ts`, `nonce`, `body` are all inside the signed
  bytes. A signature over a Dogfood message envelope cannot be replayed as
  another protocol's artifact or as a different message (recipient, type,
  and nonce are committed). This differs deliberately from attestation's
  explicit `"Dogfood Attestation v1\n"` prefix: attestations are inscriptions
  with no ecosystem verifier, while messages choose ecosystem verifiability.
  The trade-off is recorded here so it is a decision, not an accident.
- `field_indexes` is omitted (default: all preceding data pushes).
- **SIGMA upgrade path (not v1):** SIGMA binds the signature to a spent
  input (`sha256(prevTxId + prevVout)`), preventing any cross-transaction
  replay of the signed bytes. AIP alone does not bind to inputs. v1 accepts
  this because the envelope commits `to`/`type`/`nonce` and the notification
  output makes each message a distinct spend; SIGMA is a v2 hardening option.

### 4.2 Message envelope (canonical JSON)

```json
{
  "app": "dogfood",
  "body": "…",
  "from": "<sender vault address, base58 P2PKH>",
  "nonce": "<16 random bytes, 32 lowercase hex chars>",
  "to": "<recipient vault address, base58 P2PKH>",
  "ts": 1763000000,
  "type": "message",
  "v": 1
}
```

- Canonicalized with the OSP-0002 JCS subset already in `osp-scope.ts`:
  sorted keys, no floats, safe integers only, lowercase hex, UTF-8, no
  insignificant whitespace. The canonical bytes are what AIP signs and what
  the B push carries — parse → re-canonicalize → verify must round-trip.
- `ts`: Unix seconds, safe integer. Informational only (chain ordering comes
  from the tx itself); verifiers must not trust it for freshness decisions.
- `nonce`: dedupe/replay-tracking aid, unique per message; not a secret.
- `from` must equal the AIP signer address; `to` must equal the MAP `to`
  value and the notification output's payee (§5). Any mismatch = invalid.
- `body`: for `type=message`, a UTF-8 string ≤ `maxBodyBytes`. For typed
  messages (§6), a structured JSON object with the exact fields defined
  there. Unknown fields are rejected at parse (fail-closed), not ignored.
- Addresses are canonical mainnet P2PKH only (same restriction philosophy as
  the OSP-0005 wallet payment subset). Testnet is out of scope for v1.

### 4.3 Signing key

**v1 signs with the root vault key; `from` is the vault's main address.**

Rationale:
- The vault address is already the agent's payment identity — recipients can
  reply, pay, or x402-settle to the same address with no mapping table.
- The inbox scan (§7) runs on the vault address; using it as the sender
  identity keeps one address per agent.
- A derived subkey (e.g. `dogfood/message/v1`, mirroring `dogfood/osp/v1`)
  would follow the repo's role-key doctrine, but third parties cannot prove
  a subkey was derived from a particular parent vault (the same limitation
  attestations document). That breaks addressability for no v1 gain.

Trust statement (identical in spirit to attestations): the AIP signature
proves **control of the sender vault key at signing time**. It does not
prove the sender's real-world identity, honesty, or that the body is true.

## 5. Transaction shape and cost

```
inputs:  root-vault coins, smallest-first (existing selection doctrine)
out 0:   1 sat  → recipient vault address (canonical P2PKH)   [notification]
out 1:   0 sats → OP_RETURN (B | MAP | AIP, §4.1)             [message]
out 2:   change → sender vault address
fee:     from vault coins, existing estimateFee discipline
```

**Why the 1-sat notification output matters:** pure OP_RETURN data is
invisible to address-based explorers — it never appears in the recipient's
address history. The 1-sat P2PKH output makes the message tx show up in the
recipient's WoC/JungleBus address history, so the inbox (§7) works with zero
extra infrastructure. BSV has no dust limit; 1-sat outputs are standard
1Sat-ecosystem practice.

Ambiguity hygiene (OSP-0001 lesson applied):
- The notification is **exactly 1 sat** to a canonical P2PKH script distinct
  from the change script; change rides the sender address, never the
  notification script.
- A message tx is **not an OSP transition**: it carries no OSP envelope
  output and must never be parsed as one. Door tip-liveness scans look for
  exactly-one-envelope; B/MAP/AIP pushes are not OSP envelopes, so message
  txs cannot interfere — but the inbox and door scanners must keep their
  filters disjoint, and tests must assert this both ways.
- The OSP-0005 wallet payment subset rejects OP_RETURN/envelope-like payment
  scripts; that restriction is unchanged. Messages are their own operation
  kind, not a payment workaround.

**Cost:** a small message tx is roughly 300–500 bytes → ~300–500 sats at
recent fee rates (attestations cost ~1,087 sats because inscriptions are
larger), plus the 1-sat notification. Caps and accounting are fee-inclusive.

## 6. Message types

`type` is a namespaced lowercase identifier, regex `^[a-z][a-z0-9.-]{0,63}$`
(same shape as attestation types). v1 defines three:

### 6.1 `message` — generic
`body` is a plain UTF-8 string. The coordination primitive: task handoffs,
negotiation text, references to txids/URLs. No structure imposed.

### 6.2 `osp.grant.request` — cross-agent door grant ask
`body` is a structured object mirroring the existing `request_osp_grant`
contract **exactly**, plus cross-vault door identification:

```json
{
  "doorGenesisTxid": "<64 lowercase hex>",
  "doorOwnerAddress": "<door-owner derived address, base58>",
  "scopeCanonical": "<exact OSP-0002 canonical scope blob, string>",
  "expiryHeight": 900000,
  "maxEgressBytes": 65536,
  "sessionPubHex": "<33-byte compressed pubkey, lowercase hex>",
  "reason": "single line, max 280 bytes"
}
```

- `scopeCanonical` travels **byte-pinned**. If it carries OSP-0005 payment
  terms, they are `{amount_sats, script}` with the wallet's canonical
  25-byte lowercase P2PKH restriction — never an address, never rewritten.
- The receiving agent validates with the **same rules `requests.ts` applies
  at filing** (scope canonicalization, payment script shape, field types)
  before anything enters its queue. Validation happens before any key or
  chain access, exactly like the local path.
- Filing into the local escalation queue remains an **explicit agent action
  via the existing `request_osp_grant` tool**. v1 does NOT auto-file inbox
  messages into the queue (fail-closed; auto-filing is an open decision, §12).
- The human approval and signing path is unchanged: CLI-only, exact bytes,
  nothing widen-able after the decision.

### 6.3 `osp.grant.receipt` — grant delivered
```json
{
  "grantTxid": "<64 lowercase hex>",
  "scopeHash": "<OSP-0002 scope hash, lowercase hex>",
  "doorGenesisTxid": "<64 lowercase hex>"
}
```
The requesting agent verifies the receipt **on-chain** (existing door
tracking / tip-liveness evidence), not by trusting the message. The message
is a pointer; the chain is the truth.

Future types (`x402.offer`, `payment.request`, …) extend the namespace
without format changes. Unknown types are surfaced by the inbox as
uninterpreted envelopes (verified signature, raw body) — never executed.

## 7. Inbox and discovery

**v1: read-only WoC address-history scan.**
- Scan the vault address's confirmed + mempool history (existing paced WoC
  helpers), fetch candidate txs, filter for the BitCom layout with
  `MAP app=dogfood` and notification payee = this vault.
- Parse → re-canonicalize → AIP-verify each. Return
  `{from, to, type, body, txid, blockTime|firstSeen, verified}`.
- Dedupe by txid; track a high-water mark locally so repeated scans are
  cheap. Signature failures are reported as `verified:false`, never dropped
  silently and never trusted.
- Exposed as CLI `messages` and MCP `messages` (read-only, MCP-safe: public
  on-chain data only, no key access).

**Upgrade path: JungleBus push.** A subscription filtered on BitCom/MAP
output types with `app=dogfood` gives real-time delivery instead of polling.
JungleBus already parses B/MAP/AIP natively. Requires a subscription ID
(human dashboard step) and a small listener service — a later slice, not v1.

Delivery semantics are **best-effort, poll-based**: no guaranteed ordering,
no guaranteed delivery, no read receipts. Agents must treat the chain as
the source of truth and messages as hints.

## 8. Policy and safety

New `policy.json` block, **absent = DISABLED** (fail-closed, same as `osp`):

```json
"messages": {
  "maxPerDay": 20,
  "maxBodyBytes": 4096,
  "recipients": null
}
```

- `maxPerDay`: message count cap per UTC day.
- `maxBodyBytes`: canonical envelope body cap (bytes, not chars).
- `recipients`: `null` = unrestricted (explicit human choice); non-empty
  array = allowlist of canonical P2PKH addresses; `[]` = deny all.
- **Killfile always wins**, checked before signing and rechecked before
  broadcast (the `8963a00` lesson).
- Caps charge **everything that leaves the vault** (miner fee + 1-sat
  notification), fee-inclusive, against a dedicated `messages` usage scope.
- If a BRC-181 envelope is installed, it additionally gates the notification
  destination + total (same pattern as OSP paid grants).
- Shared payment guard reservation before signing; fsynced intent + evidence
  before broadcast; **single-attempt ARC**; ambiguous acknowledgement = HOLD
  for human reconciliation, never auto-retry. Pre-commitment failures release
  the reservation (safe to retry); post-broadcast uncertainty does not.
- The MCP tool never logs key material; message bodies are public by design
  (§10) but the tool still treats vault internals as secret.

**Autonomy contrast with OSP:** OSP grant *signing* is human-only because a
grant authorizes access. Message signing is **agent-autonomous under the
caps above** because a message only spends capped sats and publishes public
data — that autonomy is the feature. The escalation queue remains the path
for anything that authorizes access or exceeds policy.

## 9. CLI and MCP surface (planned)

CLI (owner):
```bash
dogfood-wallet agent-message <to-address> <body> [--type T] [--json]
dogfood-wallet messages [--from ADDR] [--type T] [--limit N]
dogfood-wallet message-verify <txid>        # keyless, like attest-verify
```

MCP (agent):
- `agent_message` — policy-gated send (autonomous within caps).
- `messages` — read-only inbox.
- `message_verify` — read-only keyless verification of a message tx.

Signing for `agent_message` lives inside the guarded operation; there is no
raw-signing MCP tool. Grant signing stays off MCP entirely (unchanged).

## 10. Trust boundaries and non-goals

- **Public and permanent.** Every message body is readable by anyone,
  forever. v1 is for coordination, not secrets. Never put keys, credentials,
  or private data in a message. Encryption (BRC-2 ECIES to the recipient's
  pubkey, supported by `@bsv/sdk`) is a clean follow-up slice, not v1.
- **Key control ≠ identity ≠ truth.** A verified signature proves the sender
  vault key signed these bytes. It proves nothing about who controls that
  vault off-chain or whether the body is honest.
- **No derivation proof.** `from` is a self-claimed vault address backed by
  key control; nothing binds it to a real-world agent identity (BAP identity
  integration is a possible later layer).
- **Best-effort delivery.** Poll-based; recipients must scan. No ordering,
  no read receipts, no censorship resistance beyond the chain itself.
- **Not an OSP transition, not a payment rail.** Messages do not open doors,
  do not settle x402, and do not move value beyond the 1-sat notification +
  fee. They coordinate; the existing rails settle.
- **Rate limits.** WoC polling is paced; heavy inbox use should migrate to
  JungleBus (§7).

## 11. Implementation slices (bounded, TDD)

Each slice is independently verifiable; funded steps require explicit
authorization. Disposable vaults + intercepted network for all tests.

- **S1 — Codec + verification (no broadcast).** Envelope canonicalization
  (reuse `osp-scope.ts` JCS), BitCom push builder/parser, strict-AIP
  sign/verify, golden vectors byte-pinned in `testdata/message-vectors.json`
  (pattern: `osp-vectors.json`). Round-trip and tamper tests.
- **S2 — Guarded send.** `policy.messages` schema + evaluation, usage scope,
  BRC-181 hook, shared guard/intent/evidence/HOLD, CLI `agent-message`,
  MCP `agent_message`. Policy-spelling and MCP-boundary tests.
- **S3 — Inbox.** WoC scan, filter, parse, verify, dedupe, high-water mark;
  CLI `messages`, MCP `messages` / `message_verify`. Assert disjointness
  from OSP door scanners both ways.
- **S4 — OSP typed messages.** `osp.grant.request` / `osp.grant.receipt`
  bodies, validation parity with `requests.ts`, cross-agent flow tests
  (message → file → approve → grant → receipt → on-chain verify) with
  intercepted chain.
- **S5 — Funded acceptance (authorized only).** One small message between
  two disposable mainnet vaults; optionally a full grant-request round trip
  on a test door. Verify tx on WoC, inbox receipt, signature, caps delta.

Gate for every slice: `bun run verify` green (full tests + typecheck) before
commit. This design doc is intentionally NOT added to `package.json`
`files` (reviewed-doc allowlist tripwire).

## 12. Open decisions

1. **Encryption timing** — plaintext v1 (recommended) vs BRC-2 ECIES from
   the start. Encryption adds recipient-key handling and an MCP decryption
   surface; defer unless a concrete private-coordination need appears.
2. **JungleBus vs polling** — v1 polls; subscription needs a human dashboard
   step and a listener. Revisit when inbox latency matters.
3. **Auto-filing grant requests** — should verified `osp.grant.request`
   messages auto-file into the owner queue? v1: no (explicit agent action).
   Auto-filing is safe-ish (human still approves) but changes the queue's
   threat model; decide separately.
4. **Role subkey** — migrate signing to `dogfood/message/v1` if a derivation
   -proof mechanism (e.g. BAP) lands; v1 uses the root key for addressability.
5. **SIGMA binding** — input-bound signatures as v2 hardening (§4.1).
