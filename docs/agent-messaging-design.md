# Agent-to-Agent Messaging — v2 Design (Locus-native)

**Status: S1–S4 IMPLEMENTED (2026-11-17); S5 pending.** Implementation
progress is tracked per slice in §12; funded steps still require explicit
authorization. This revises v1 (`964bd54`) after
grounding in the actual Locus Protocol spec and reference implementation
(provenance: §14). v1 carried messages as a standalone Dogfood BitCom
format; v2 makes messaging **Locus-native** (riding the existing `mint`
op) and adds a **platform-owned agent identity convention**. The OSP
alignment, safety model, and slice discipline from v1 are retained
verbatim where unchanged. Implementation follows §12 under the repo's
TDD and verification gates; this doc authorizes no code, no broadcast,
and no shared-protocol modification.

## 1. Purpose

Let one agent deliver a short, signed, durable message to another
agent's vault address, recorded permanently on BSV and **discoverable by
any Locus indexer** — not just Gryd. The recipient reads an inbox with
zero shared infrastructure. Messages are public coordination artifacts:
offers, requests, receipts, attestations-between-agents.

Dogfood today lets agents *pay* (send, x402, bridge, OSP paid grants) and
*attest* (owner-only signed observations). It does not let agents *talk
to each other*. Messaging adds the coordination layer: agents negotiate
terms, request access, and hand off tasks on-chain, then settle with the
payment rails that already exist.

**Corrected stack framing.** Locus is the *platform protocol* — an open,
wallet-agnostic convention for location-anchored ownable objects
("pins") on BSV. Its spec states plainly that *"Gryd.world is the
reference visual indexer… it holds no privileged position"* and anyone
can construct, broadcast, and index pins with any BSV tooling, without
accounts or permission. So:

- **Locus** — the platform contract (pins, canonical JSON payload,
  ownership-as-UTXO, the signed-write action vocabulary). Any BRC-100
  wallet works.
- **Gryd** — one indexer/app on Locus (the visual world + backend).
- **Dogfood** — a wallet/safety rail that signs and settles; one BRC-100
  implementation among many.
- **OSP** — a paid-access protocol that plugs into the platform.
- **Messaging (this doc)** — a coordination protocol that plugs into the
  platform, riding Locus's own pin mechanism.

Two buses make the separation efficient: **BSV** (settlement +
permanence) and **Locus** (world/object/identity contract). Domain
protocols compose through them without routing through any single app.
An agent can compose `message → negotiation → OSP paid grant / x402 /
send` into cross-agent commerce with no hosted intermediary.

## 2. Alignment with recent OSP work (unchanged from v1)

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

## 3. Locus platform integration (the v2 core)

### 3.1 Why ride Locus `mint` instead of inventing a new op

A Locus mint transaction is an ordinary BSV transaction with:

- a **tip output**: exactly 1 satoshi (recommended; any positive amount
  valid) via plain P2PKH to the **owner address**; the pin's persistent id
  is that outpoint `<txid>.<vout>` (spec §3.1);
- a **payload output**: zero-sat `OP_FALSE OP_RETURN` carrying canonical
  JSON `{p:"locus", v:3, op:"mint", …}` (spec §4, §7.2);
- optional other outputs + change.

Two spec rules make this a *native* fit for messaging, not a stretch:

1. **Attribution is permissionless** (§10.2): *"Anyone can pay 1 sat to
   your address with a payload naming you owner — you then hold (and
   control) the pin… Clients SHOULD filter spam views, not censor the
   index."* This is precisely the agent-message inbox: the **sender funds
   and signs** a mint that names the **recipient as owner**. The reference
   builder supports this directly — `resolveOwnerAddress` takes an explicit
   `ownerAddress` independent of the signing key
   (`transaction-builder.ts:507`).
2. **Ownership is the tip UTXO** (§10.1): the indexer sets `owner` from the
   payload, then confirms a positive-value output pays that address. The
   recipient's set of owned message-pins **is** their inbox, and any Locus
   indexer already reads it.

So a message is a **mint of an ownable object** with `type:"object"` and a
message `subtype` (subtype is convention, not consensus — §6.7/§9).
**No new Locus op is required and no shared protocol is modified.** This
preserves the wallet's standing doctrine (attestations, OSP, signed-write
all *use* Locus without changing it). A bespoke `op:agent.message` would
require a SPEC.md proposal + JSON schema + indexer governance; riding
`mint` + `content` + subtype convention avoids that entirely.

### 3.2 The inbox convergence

v1's "1-sat notification output so the message appears in the recipient's
address history" is **structurally identical to the Locus tip rule**. v2
stops treating it as a trick and treats it as the platform primitive: the
1-sat tip to the recipient *is* a Locus pin owned by the recipient.
Discovery is the standard Locus indexer recipe (spec §5,
`parse.ts:findLocusPayload`) — no Dogfood-specific scanner is needed for
platform-native views.

### 3.3 Sender authentication — the one real gap

Locus native attribution proves **who owns** a pin (the recipient), not
**who authored** it. The payload's `owner_pubkey` is the recipient's; a
mint carries no sender signature, and anyone can attribute a pin to anyone
(§10.2 is permissionless *by design*). Authorship must therefore be carried
explicitly:

- The message body is a **canonical signed envelope** (§5.2) embedded in
  the mint payload's `content` field (`content_type:"application/json"`).
- The envelope carries `from` (sender vault P2PKH address) and a **sender
  signature** over the canonical envelope bytes excluding the signature
  field, produced by the sender's root vault key.
- A reader verifies the embedded signature against `from`'s pubkey
  independently of the Locus layer. **Locus proves delivery + ownership +
  discovery; the embedded signature proves authorship.** Neither alone is
  sufficient.

Option A (§3.6) instead uses a strict chained BitCom AIP push for ecosystem
AIP verifiers; the signed-envelope core is shared between both options.

### 3.4 Platform-owned agent identity convention

The seam v1 named — one agent with four related-but-ununified identities
(Gryd agent id, vault address, OSP door-owner key, message sender) — is
resolved by making the **Locus agent pin the canonical identity**:

- An agent is a Locus pin with `type:"agent"`, created by `op:mint`,
  carrying `owner` + `owner_pubkey` (compressed SEC hex, 33 bytes — §6.4).
  Its pin id `<txid>.<vout>` is the platform-stable agent id.
- The Dogfood **vault address** is the P2PKH derived from that
  `owner_pubkey` (`publicKeyToAddress`). The **message sender** (`from`)
  and the **OSP door-owner key** resolve back to the same agent pin.
- Message envelopes carry, for both parties, the vault address **and an
  optional `agentPin` ref** (`<txid>.<vout>`). A verifier resolves the pin's
  `owner_pubkey` → address and checks it matches the embedded signature's
  recovered key. A message whose `from` does not resolve to the claimed
  agent pin is surfaced as **unbound**, never silently trusted.
- The Gryd in-world agent id maps to the same pin via the existing
  deposit/registration binding (vault address ↔ in-world agent). This doc
  proposes the convention; it does not modify Gryd or Locus.

This is the highest-leverage integration: it turns "many protocols sharing
a chain" into "one agent across the platform," at no new protocol surface —
agent pins already exist in Locus.

### 3.5 New consequences the wallet must handle (honest costs)

Going Locus-native is not free:

1. **Message tips are owned pins, not disposable dust.** Spending the 1-sat
   tip *transfers* the pin (§3.1, §10.5). The vault's smallest-first coin
   selection must **exclude inbox message-tip UTXOs** from funding (or
   deliberately accept transfer semantics). v1's BitCom notification was
   freely spendable dust; v2's tip is an owned artifact. New selection rule,
   new test surface.
2. **Content/metadata is untrusted** (§6.7): attacker-controlled text. Never
   execute it, never render it as HTML, never feed it to an LLM without
   marking it untrusted. The inbox surfaces unknown subtypes as
   uninterpreted data. Reinforces v1's "never auto-execute."
3. **Coordinate-less mint divergence — VERIFIED NEGATIVE at S1 (2026-11-17).**
   Read-only check against the reference indexer (`the-grid-agent-splash`,
   `locus-mobile/backend/locus_api`): `schemas/mint.json` requires only
   `p/v/op/owner/owner_pubkey` (coords optional) and `pin_chain_verifier.ex`
   gates only `v`/`op` — but pin persistence rejects coordinate-less mints:
   the pin changeset/DB require `lat`, `lng`, `location`, `geohash`,
   `placed_at` (`null: false`), the changeset never casts/stores `content`
   (only `content_uri`), and the type list excludes `agent` (object pins get
   `address_prefix:"/1"`). **Option B as designed is not indexed by the
   current reference indexer.** Per the fallback below, S1 ships Option A;
   Option B remains the target pending indexer evolution (no unilateral
   shared-protocol change).
4. **Insert-only by txid** (§10.4): replays are ignored by indexers. Aligns
   with the wallet's reserve-before-broadcast replay store; reuse it.
5. **Subtype rendering is convention.** Indexers index the mint; special
   in-world rendering of `agent-message` is a renderer concern, not
   guaranteed. Discovery works regardless; pretty display is follow-up.

### 3.6 Format decision — two honest options

- **Option A — BitCom peer protocol.** Keep v1's chained `B | MAP | AIP`
  OP_RETURN (`app=dogfood`, `type=agent-message`, §5.3). Strict AIP gives
  ecosystem-verifiable sender auth; discovery via BitCom/MAP indexers
  (JungleBus). Locus-aware only through identity refs (§3.4). A legitimate
  *peer* application protocol on BSV — Locus itself is just one such
  protocol. No Locus transport, no owned-pin inbox, no coin-selection
  change.
- **Option B — Locus-native (recommended).** `op:mint`, `type:"object"`,
  `subtype:"agent-message"`, recipient as owner, 1-sat tip = inbox pin,
  signed envelope embedded in `content` (§5.1–5.2). Native Locus indexer
  discovery + platform identity + pin inbox; sender auth via the embedded
  signature. Inherits the §3.5 costs.

**Recommendation:** ship **Option B** for platform-native discovery and
identity, retaining the **signed-envelope core** so Option A remains an
interop/fallback path (e.g. for coordinate-less-mint indexing gaps,
§3.5.3). Recorded as a decision in §13 — a design choice, not a unilateral
protocol change. If native indexer discovery proves low-value in practice,
Option A is the cheaper steady state.

**S1 update (2026-11-17):** the §3.5.3 check came back negative — the
reference indexer does not persist coordinate-less mints or their `content`.
The fallback therefore applies: **Option A is the active transport** (codec
shipped at S1, `src/agent-message.ts`), and the Option B codec is retained
and byte-pinned so it activates unchanged if/when the indexer evolves.

## 4. Existing primitives reused

| Primitive | Location | Reuse |
|---|---|---|
| Locus mint builder / payload parser | `@locus/protocol` `transaction-builder.ts` (`buildMintTx`, `buildMintPayload`), `parse.ts` (`findLocusPayload`) | Option B transport + discovery; reuse rather than reimplement the pin format |
| Canonical JSON (JCS subset: sorted keys, no floats, safe integers, lowercase hex) | `src/osp-scope.ts` | Envelope canonicalization — same discipline as OSP-0002 scope blobs and Locus §4 |
| BSM signing / keyless verification | `src/auth-sign.ts` | Embedded envelope signature (Option B) and AIP `BITCOIN_ECDSA` (Option A); verification needs no vault key |
| Shared payment guard, persisted intent, fsynced evidence, single-attempt broadcast, HOLD | `src/payment-guard.ts`, `src/send.ts`, `src/utxo-treasury.ts` | The message broadcast is a guarded spend like any other |
| Policy engine + usage accounting | `src/policy.ts`, `src/vault.ts` | New `messages` block and `messages` usage scope |
| BRC-181 envelope gates | `src/brc181.ts` | If installed, gates the tip destination + total |
| Escalation queue (`osp-grant` ask kind) | `src/requests.ts` | Receiving agent files cross-agent grant requests through existing validation |
| WoC read helpers (paced, read-only) | `src/send.ts`, `src/osp.ts` | Inbox scan and receipt verification |
| OSP codecs + golden vectors | `src/osp-envelope.ts`, `testdata/osp-vectors.json` | Byte-pinning pattern for the message codec's own vectors |

No new runtime dependency is strictly required: Locus payloads and BitCom
pushes are plain script pushdata constructible with the existing
`@bsv/sdk`. Reusing `@locus/protocol` (Option B) is preferred to keep the
pin format byte-exact; adding it as a dependency would need the
dependency-declaration gate in `scripts/package.test.ts`. `@1sat/templates`
is an optional convenience, not a requirement.

## 5. On-chain format

### 5.1 Locus mint payload (Option B transport)

Canonical JSON (sorted keys recursively, no whitespace, UTF-8 — Locus §4,
matching the OSP-0002 JCS subset in `src/osp-scope.ts`), in a zero-sat
`OP_FALSE OP_RETURN`:

```json
{
  "p": "locus",
  "v": 3,
  "op": "mint",
  "type": "object",
  "subtype": "agent-message",
  "owner": "<recipient vault P2PKH address>",
  "owner_pubkey": "<recipient compressed pubkey, lowercase hex>",
  "content_type": "application/json",
  "content": "<canonical signed message envelope, §5.2>",
  "nonce": 1234567890,
  "ts": 1763000000
}
```

- `nonce` here is the Locus uint32 geo-nonce convention; the *envelope*
  nonce (§5.2) is a separate 32-hex dedupe aid.
- `lat`/`lng`/`geohash` omitted (coordinate-less; §3.5.3 verification
  pending) or set to the recipient agent pin's anchor.
- `metadata` MAY carry optional `agentPin` refs; it is untrusted (§6.7).
- `owner`/`owner_pubkey` are the **recipient** (permissionless attribution,
  §3.1); the sender is authenticated only by the embedded envelope (§3.3).

### 5.2 The signed message envelope (authorship core, shared by A and B)

Embedded in `content` (Option B) or in the `B` push (Option A). Canonical
JSON; the signature covers the envelope **excluding** `sig`:

```json
{
  "app": "dogfood",
  "v": 1,
  "type": "<message type, §7>",
  "from": "<sender vault P2PKH address>",
  "to": "<recipient vault P2PKH address>",
  "fromAgentPin": "<txid>.<vout> (optional)",
  "toAgentPin": "<txid>.<vout> (optional)",
  "nonce": "<16 random bytes, 32 lowercase hex chars>",
  "ts": 1763000000,
  "body": { "...type-specific fields, §7..." },
  "sig": "<sender signature over canonical envelope-minus-sig>"
}
```

- Canonicalized with the OSP-0002 JCS subset in `osp-scope.ts`: sorted
  keys, no floats, safe integers, lowercase hex, UTF-8, no insignificant
  whitespace. Parse → re-canonicalize → verify must round-trip; reject on
  any drift. Unknown envelope fields are **rejected**, not ignored.
- `from` is the sender's root vault address — the same address used for
  payment and reply (§5.4). `from` must equal the signature's recovered
  address; `to` must equal the Locus `owner` (Option B) / MAP `to` + tip
  payee (Option A). Any mismatch = invalid.
- `sig`: compact BSM (Bitcoin Signed Message) or DER ECDSA over the
  canonical envelope bytes excluding `sig`, domain-separated by the
  `app`/`v`/`type`/`from`/`to`/`nonce` fields *inside* the signed bytes. A
  signature over this envelope cannot be replayed as another protocol's
  artifact or a different message (recipient, type, nonce committed).
- `ts`: Unix seconds, safe integer, informational only — verifiers must not
  trust it for freshness (chain ordering comes from the tx).
- `nonce`: dedupe/replay-tracking aid, unique per message, not a secret.
- Addresses are canonical mainnet P2PKH only (same restriction philosophy
  as the OSP-0005 wallet payment subset). Testnet out of scope for v1.

### 5.3 Option A — BitCom B | MAP | AIP layout (active transport since S1)

One OP_RETURN (bare `6a` per §6.2), chained per BitCom so ecosystem indexers
(JungleBus, 1Sat tooling) parse and verify natively. Exactly **18 pushes**,
pipes included, no empty pushes:

```
OP_RETURN
  | B_PREFIX                              (19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut)
  | <envelope>                            (UTF-8 canonical JSON, §5.2, single push, no sig)
  | "application/json"
  | "utf-8"
  | "|"
  | MAP_PREFIX                            (1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5)
  | "SET"
  | "app"  | "dogfood"
  | "type" | <message type>               (§7)
  | "to"   | <recipient vault address>
  | "|"
  | AIP_PREFIX                            (15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva)
  | "BITCOIN_ECDSA"
  | <sender vault address>
  | <signature: raw 65-byte compact push>
```

- **AIP byte rules — PINNED at S1** (`src/agent-message.ts`, golden vectors
  in `testdata/message-vectors.json`, cross-checked against three reference
  implementations and one real mainnet anchor tx):
  - **Preimage** = `0x6a` || raw concatenation of ALL pushdata *contents*
    left of the AIP prefix (pipes included, length prefixes excluded),
    hashed with the Bitcoin Signed Message magic hash. Our layout has no
    empty pushes, so the bitcoinfiles-sdk rule and `@1sat/templates`'
    per-protocol reconstruction produce identical bytes.
  - **Canonical build**: raw 65-byte compact recoverable signature pushed
    directly (bitcoinfiles-sdk / `@1sat/templates` convention), compressed
    key, header 31–34, low-S. Signing is deterministic (DRBG seeded by
    key+message), so vectors are byte-stable.
  - **Parse interop**: also accepts the signature as base64-ASCII text
    (go-aip convention) and uncompressed-key headers 27–30 (legacy anchors).
    Envelope-level `sig` (§5.2) is always compressed.
  - **Anchor**: tx `5633bb966d9531d22df7ae98a70966eebe4379d400d74ac948bf5b4f2867092c`
    (B | AIP | AIP, uncompressed key, empty filename push) verifies through
    the same preimage rule — pinned as an interop fixture.
  - `field_indexes` omitted (default: all preceding data pushes).
- In Option A the envelope `sig` field is omitted in favor of the chained
  AIP signature (the AIP push is the authorship proof); the canonical
  envelope-minus-sig bytes are embedded in the B push and covered by the
  AIP preimage. Parsers accept an embedded `sig` too and verify it when
  present.
- **Strict shape parsing**: minimal pushes only (PUSHDATA1/2/4 accepted when
  minimal), exact push count/order, MAP values cross-checked against the
  envelope (`app`/`type`/`to`), AIP address must equal `envelope.from`.
- **SIGMA upgrade path (not v1):** SIGMA binds the signature to a spent
  input (`sha256(prevTxId + prevVout)`), preventing cross-transaction replay
  of the signed bytes. AIP alone does not bind to inputs. v1 accepts this
  because the envelope commits `to`/`type`/`nonce` and the tip output makes
  each message a distinct spend; SIGMA is a later hardening option.

### 5.4 Signing key

**v1/v2 sign with the root vault key; `from` is the vault's main address.**

- The vault address is already the agent's payment identity — recipients
  reply, pay, or x402-settle to the same address with no mapping table.
- The inbox scan (§8) runs on the vault address; using it as sender identity
  keeps one address per agent.
- A derived subkey (e.g. `dogfood/message/v1`, mirroring `dogfood/osp/v1`)
  would follow the repo's role-key doctrine, but third parties cannot prove
  a subkey derived from a particular parent vault (the attestation
  limitation). That breaks addressability for no v1 gain. The §3.4 agent-pin
  binding is the identity layer, not a subkey.

Trust statement: the signature proves **control of the sender vault key at
signing time** — not real-world identity, honesty, or truth of the body.

### 5.5 Size and cost

Keep the envelope body ≤ `maxBodyBytes` (default 4 KB). A small message tx
is roughly 300–500 bytes → ~300–500 sats at recent fee rates, plus the 1-sat
tip. Caps and accounting are fee-inclusive. Messages are short coordination
artifacts, not file transfer; `content_uri` can point at larger off-chain
content if ever needed (out of scope for v1).

## 6. Transaction shape

### 6.1 Option B (Locus mint)

```
inputs:  sender vault UTXOs, smallest-first, EXCLUDING inbox message tips
         (§3.5.1), total ≥ fee + 1 sat
out 0:   1 sat  → P2PKH(recipient owner address)   [Locus tip / pin]
out 1:   0 sats → OP_FALSE OP_RETURN <Locus mint JSON, §5.1>
out 2:   change → sender vault address
fee:     from vault coins, existing estimateFee discipline
```

Mirrors `buildMintTx` (`transaction-builder.ts:970`): ordinal tip
(`DEFAULT_ORDINAL_SATOSHIS = 1`) P2PKH to owner + JSON OP_RETURN.

### 6.2 Option A (BitCom)

```
inputs:  root-vault coins, smallest-first
out 0:   1 sat  → recipient vault address (canonical P2PKH)   [notification]
out 1:   0 sats → OP_RETURN (B | MAP | AIP, §5.3)             [message]
out 2:   change → sender vault address
```

### 6.3 Ambiguity hygiene (both options, OSP-0001 lesson)

- The tip/notification is **exactly 1 sat** to a canonical P2PKH script
  distinct from change; change rides the **sender** address, never the tip.
- A message tx is **not an OSP transition**: it carries no OSP envelope
  output and must never be parsed as one. Door tip-liveness scans look for
  exactly-one-envelope; Locus JSON / B|MAP|AIP pushes are not OSP envelopes,
  so message txs cannot interfere — but inbox and door scanners must keep
  filters disjoint, and tests assert this both ways.
- The OSP-0005 wallet payment subset rejects OP_RETURN/envelope-like payment
  scripts; unchanged. Messages are their own operation kind, not a payment
  workaround.
- BSV has no dust limit; 1-sat outputs are standard 1Sat-ecosystem practice.

## 7. Message types

`type` is a namespaced lowercase identifier, regex `^[a-z][a-z0-9.-]{0,63}$`
(same shape as attestation types). v1 defines three:

### 7.1 `message` — generic
`body` is a plain UTF-8 string ≤ `maxBodyBytes`. The coordination primitive:
task handoffs, negotiation text, references to txids/URLs. No structure
imposed.

### 7.2 `osp.grant.request` — cross-agent door grant ask
`body` mirrors the existing `request_osp_grant` contract **exactly**, plus
cross-vault door identification:

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

- `scopeCanonical` travels **byte-pinned**. OSP-0005 payment terms are
  `{amount_sats, script}` with the wallet's canonical 25-byte lowercase
  P2PKH restriction — never an address, never rewritten.
- The receiving agent validates with the **same rules `requests.ts` applies
  at filing** (scope canonicalization, payment script shape, field types)
  before anything enters its queue — before any key or chain access.
- Filing into the local escalation queue remains an **explicit agent action
  via the existing `request_osp_grant` tool**. v1 does NOT auto-file inbox
  messages (fail-closed; auto-filing is an open decision, §13).
- Human approval and signing unchanged: CLI-only, exact bytes, nothing
  widen-able after the decision.

### 7.3 `osp.grant.receipt` — grant delivered
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

Future types (`x402.offer`, `payment.request`, `attestation`, …) extend the
namespace without format changes. Unknown types are surfaced by the inbox as
uninterpreted envelopes (verified signature, raw body) — never executed
(§6.7 untrusted-content rule).

## 8. Inbox and discovery

**Platform-native view (Option B):** the recipient's owned message-pin set,
read by any Locus indexer (spec §5 recipe). The wallet's own read-only inbox:

- Scan the vault address's confirmed + mempool history (paced WoC helpers),
  fetch candidate txs, filter Locus mints with `subtype:"agent-message"` and
  tip payee = this vault (Option A: filter BitCom `MAP app=dogfood`).
- Parse `content` → re-canonicalize → verify the embedded signature; resolve
  agent-pin bindings (§3.4). Return
  `{from, fromAgentPin?, to, type, body, txid, pinId?, blockTime|firstSeen,
  verified, bound}`.
- Dedupe by txid; track a high-water mark locally so repeated scans are cheap.
  Signature failures reported as `verified:false`, never dropped silently,
  never trusted. Unresolvable identity surfaced as `bound:false`.
- **Keyless and read-only:** no vault decrypt, no policy mutation, no spend.
  MCP-safe (public on-chain data only).
- **Spam filtering is the client's job** (§10.2): recipient policy (§9)
  decides what to surface; the index stays neutral.

**Upgrade path:** JungleBus BitCom/MAP subscription (Option A) or a Locus
indexer feed (Option B) for real-time push instead of polling. Requires a
subscription ID (human dashboard step) and a small listener — a later slice,
not v1.

Delivery semantics are **best-effort, poll-based**: no guaranteed ordering,
no guaranteed delivery, no read receipts. The chain is the source of truth;
messages are hints.

## 9. Policy and safety

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
- Caps charge **everything that leaves the vault** (miner fee + 1-sat tip),
  fee-inclusive, against a dedicated `messages` usage scope.
- If a BRC-181 envelope is installed, it additionally gates the tip
  destination + total (same pattern as OSP paid grants).
- Shared payment guard reservation before signing; fsynced intent + evidence
  before broadcast; **single-attempt ARC**; ambiguous acknowledgement = HOLD
  for human reconciliation, never auto-retry. Pre-commitment failures release
  the reservation (safe to retry); post-broadcast uncertainty does not.
- The MCP tool never logs key material; bodies are public by design (§11) but
  vault internals stay secret.

**v2 additions:**

- **Coin-selection exclusion (§3.5.1):** inbox message-tip UTXOs are excluded
  from funding selection so sending a message never accidentally transfers an
  owned inbox pin. New persisted marking + new tests.
- **Untrusted content (§6.7):** inbox output marks body/metadata untrusted;
  never auto-executed, rendered as HTML, or fed to an LLM unmarked.

**Autonomy contrast with OSP:** OSP grant *signing* is human-only because a
grant authorizes access. Message signing is **agent-autonomous under the caps
above** because a message only spends capped sats and publishes public data —
that autonomy is the feature. The escalation queue remains the path for
anything that authorizes access or exceeds policy.

## 10. CLI and MCP surface (planned)

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

## 11. Trust boundaries and non-goals

- **Authorship ≠ ownership ≠ identity ≠ truth.** The embedded signature
  proves the sender vault key signed these bytes (authorship). Locus
  attribution proves the recipient owns the pin (ownership/delivery) — it
  does **not** prove who sent it (§3.3). Agent-pin refs bind addresses to
  platform identities; an unresolvable binding is `bound:false`, never
  silently trusted. None of these proves off-chain identity or honesty.
- **Public and permanent.** Every body is readable by anyone, forever. v1 is
  for coordination, not secrets. Never put keys, credentials, or private data
  in a message. Encryption (BRC-2 ECIES to the recipient's pubkey, supported
  by `@bsv/sdk`) is a clean follow-up slice, decrypted only after the
  recipient's policy accepts (gate-before-decrypt, `8963a00`).
- **No derivation proof.** `from` is a self-claimed vault address backed by
  key control; the agent-pin binding (§3.4) is the identity layer, not a
  derivation proof. BAP identity integration is a possible later layer.
- **Best-effort delivery.** Poll-based; recipients must scan. No ordering, no
  read receipts, no censorship resistance beyond the chain itself.
- **Not an OSP transition, not a payment rail.** Messages do not open doors,
  do not settle x402, and move no value beyond the 1-sat tip + fee. They
  coordinate; the existing rails settle.
- **Rate limits.** WoC polling is paced; heavy inbox use migrates to JungleBus
  / a Locus feed (§8).

## 12. Implementation slices (bounded, TDD)

Each slice independently verifiable; funded steps require explicit
authorization. Disposable vaults + intercepted network for all tests.

- **S1 — Codec + verification (no broadcast). ✅ DONE 2026-11-17.**
  `src/agent-message.ts`: signed-envelope canonicalize/sign/verify (reuses
  `osp-scope.ts` JCS + BSM), Option A BitCom push builder + strict-AIP
  sign/verify (18-push layout, §5.3), Option B Locus mint payload
  builder/parser (coordinate-less v1 shape, retained for indexer evolution).
  Golden vectors byte-pinned in `testdata/message-vectors.json` (pattern:
  `osp-vectors.json`), including a real mainnet AIP anchor tx as an interop
  fixture; 59 tests (round-trip, tamper, strict-shape, disjointness from OSP
  envelopes both ways). Read-only indexing check completed: **negative** —
  see §3.5.3; Option A is the active transport, Option B deferred.
  No broadcast, no vault access, no CLI/MCP surface added.
- **S2 — Guarded send. ✅ DONE 2026-11-17.** `policy.messages` schema +
  evaluation (absent = DISABLED; strict mainnet P2PKH recipients — P2SH
  rejected; maxPerDay / maxBodyBytes / recipients allowlist), fee-inclusive
  `messages` usage scope (also feeds bsv / brc181-bsv), BRC-181 pre/post gate,
  shared guard/intent/fsynced-evidence/HOLD (`agent-message` operation),
  inbox-tip outpoint exclusion store (`src/inbox-tips.ts`, fail-closed),
  CLI `agent-message` (+`--json`), MCP `agent_message` (registry pins updated).
  51 new tests; full verify 1319/0. Intercepted transport only — zero
  broadcasts, no funding. Fee model covers real tx size (OP_RETURN
  CompactSize length included); dust change folds like send.ts.
- **S3 — Inbox. ✅ DONE 2026-11-17.** `src/agent-message-inbox.ts`: keyless,
  read-only WoC scan (`confirmed/history` asc from high-water+1, plus
  `unconfirmed/history`, ≥350 ms pacing under the 3 req/s limit), strict
  Option A/B classification, 1-sat P2PKH tip-payee inbox filter (sent
  messages never pollute the sender's inbox), agent-pin binding (pin owner
  pubkey must equal the verified authorship key; unverified messages never
  bind), fail-closed `inbox.json` store (dedupe by txid + confirmed-height
  high-water mark that never advances past an unprocessed tx; mempool→
  confirmed upgrades without re-fetch; 500-entry cache cap). Bad signatures
  surface `verified:false` — never silently dropped, never trusted. Every
  entry/body carries `untrusted:true` (prompt-injection boundary).
  Scanner-level disjointness from OSP door envelopes asserted both ways.
  CLI `messages` (`--address/--from/--type/--limit/--json`), MCP `messages`
  / `message_verify` (registry pins updated incl. `scripts/verify-package.ts`).
  48 new tests; full verify 1367/0; `verify:package` green. Zero broadcasts,
  no funding, no vault decryption. Live-verified read-only: full history
  scan of the vault address (high-water 975782) and a zero-refetch
  incremental rescan; WoC's 404-on-empty-page quirk handled fail-safe.
- **S4 — OSP typed messages. ✅ DONE 2026-11-17.** `src/agent-message-osp.ts`:
  keyless parse/match/verify for `osp.grant.request` / `osp.grant.receipt`.
  The wire format is the S1 codec's pinned contract (typed bodies are JSON
  objects: request `{scope, doorGenesisTxid, doorOwnerAddress, reason,
  sessionPubHex}` + optional `{expiryHeight, maxEgressBytes}`; receipt
  exactly `{grantTxid, scopeHash, doorGenesisTxid}`) — no new format.
  Filing-parity validation (canonical JCS scope + salt, wallet P2PKH payment
  restriction, bounds, reason rules, compressed 02/03 session pubkey) runs
  BEFORE any key or chain access; where the codec is looser than filing
  (e.g. `expiryHeight` 0), the filing rule wins — anything parseable is
  filable. Scope travels byte-pinned (`scope` → `scopeCanonical`, never
  rewritten); filing stays explicit (`grantRequestToFilingInput` maps, never
  auto-files); `matchDoor` binds against the filing agent's OWN registry.
  Receipts are pointers: `verifyGrantReceipt` fetches the grant tx and checks
  the actual OSP envelope (push-header parsed directly; SDK chunk views fold
  PUSHDATA bytes into OP_RETURN data), scopeHash reproduction from the exact
  scope bytes, door-genesis binding, and paid-scope payment-output presence.
  Guarded send accepts the two typed types (object or JSON-text body);
  unknown types still `BAD_TYPE`, invalid typed bodies `BAD_BODY` pre-fetch.
  MCP `agent_message` gains optional `type`; CLI `--type` already passed
  through. Cross-agent flow test: message → inbox → file → approve → grant →
  receipt → on-chain verify on one shared intercepted chain. 34 new tests;
  full verify 1401/0; `verify:package` green. Zero broadcasts, no funding,
  no Locus/shared-protocol modification.
- **S5 — Funded acceptance (authorized only).** One small message between two
  disposable mainnet vaults; optionally a full grant-request round trip on a
  test door. Verify tx on WoC, inbox receipt, signature, caps delta, and mined
  status independently.

Gate for every slice: `bun run verify` green (full tests + typecheck) before
commit. This design doc is intentionally NOT added to `package.json` `files`
(reviewed-doc allowlist tripwire).

## 13. Open decisions

1. **Format elevation (Option A vs B, §3.6). RESOLVED at S1 (2026-11-17):**
   coordinate-less mints do NOT index in the current reference indexer
   (§3.5.3 verdict), so **Option A ships first**; the Option B codec is
   implemented and byte-pinned, activating unchanged if the indexer evolves.
   Revisit when the reference indexer stores coordinate-less object mints
   with `content`. A design choice, not a Locus spec change.
2. **Identity binding depth.** How strictly to enforce agent-pin resolution in
   v1 (surface-as-unbound vs reject). Recommend surface-as-unbound; reject is a
   later policy option.
3. **Coin-selection marking.** How inbox tips are marked/persisted so selection
   excludes them without breaking existing spend rails.
4. **Encryption timing.** Plaintext v1 (recommended) vs BRC-2 ECIES from the
   start. Encryption adds recipient-key handling and an MCP decryption surface;
   defer unless a concrete private-coordination need appears.
5. **JungleBus vs polling.** v1 polls; subscription needs a human dashboard step
   and a listener. Revisit when inbox latency matters.
6. **Auto-filing grant requests.** Should verified `osp.grant.request` messages
   auto-file into the owner queue? v1: no (explicit agent action). Auto-filing
   is safe-ish (human still approves) but changes the queue's threat model;
   decide separately.
7. **Role subkey.** Migrate signing to `dogfood/message/v1` if a derivation-proof
   mechanism (e.g. BAP) lands; v1 uses the root key for addressability.
8. **SIGMA binding.** Input-bound signatures as later hardening (§5.3).
9. **Subtype naming.** `agent-message` is convention; align with any Locus
   note-subtype convention (§10.3) if renderers adopt one. No consensus change.
10. **Standalone protocol status.** Messaging stays a Dogfood application format
    riding Locus until a second non-Dogfood consumer justifies a standalone
    spec. Do not prematurely protocol-ize.

## 14. Provenance / spec references

Every Locus claim above is grounded in:

- **Locus Protocol Specification v3.0**, fetched 2026-11-17 from
  `https://gryd.world/protocol/SPEC.md` (canonical home; "Draft for public
  review — describes the format live on BSV mainnet today"). Cited: §3.1 (tip
  output), §4 (canonical JSON payload), §5 (discovery), §6.4
  (owner/owner_pubkey), §6.7 (untrusted metadata), §7.2 (mint), §9 (subtype
  convention), §10.1–10.5 (ownership / permissionless attribution /
  immutability / insert-only / transfers). Local copy:
  `cache/scratch/locus-spec.md`.
- **Reference implementation `@locus/protocol` 0.2.1**, in
  `the-grid-agent-splash/packages/locus-protocol`, grid checkout HEAD
  `79a458f157b02a5456548e2faa920ae0e39225aa` (read-only). Cited:
  `transaction-builder.ts` `DEFAULT_PROTOCOL_VERSION=3` (:28),
  `DEFAULT_ORDINAL_SATOSHIS=1` (:31), `resolveOwnerAddress` (:507),
  `buildMintPayload` (:924, coordinate-less permitted), `buildMintTx` (:970,
  1-sat P2PKH tip + JSON OP_RETURN); `parse.ts:findLocusPayload`.
- **Reference indexer — READ at S1 (2026-11-17, read-only):**
  `the-grid-agent-splash/locus-web/public/protocol/schemas/mint.json` +
  `common.json`, and `locus-mobile/backend/locus_api/lib/locus_api/world/`
  (`pin_chain_verifier.ex`, `pin_indexer.ex`, `pin.ex`, `world.ex`) plus
  migration `20260504000100_create_open_world_v2.exs`. Verdict in §3.5.3:
  schema/verifier pass coordinate-less mints, but pin persistence requires
  coordinates and never stores `content` → Option B not indexed as designed.
- **AIP provenance (S1):** original spec `iliad-masterkey/AUTHOR_IDENTITY_PROTOCOL`;
  reference implementations `BitcoinFiles/bitcoinfiles-sdk` (`lib/utils.ts`),
  `BitcoinSchema/go-aip`, `@1sat/templates@0.1.1` (`dist/bitcom/aip.js`);
  BRC-0217 ordering convention (`https://bsv.brc.dev/tokens/0217`).
  Byte rules validated against real mainnet tx
  `5633bb966d9531d22df7ae98a70966eebe4379d400d74ac948bf5b4f2867092c`
  (pinned in `testdata/message-vectors.json`).

OSP: `https://github.com/futureman19/open-and-shut-protocol` (OSP-0001…0008);
wallet OSP hardening commits `16af988`, `c5ff067`, `8963a00`; `src/osp.ts`,
`src/osp-scope.ts`, `src/requests.ts`.

This document is excluded from the npm package `files` list (unreviewed
design). S1 codec implementation was separately authorized by the owner
("Start S1", 2026-11-17); this doc still authorizes no broadcast and no
shared-protocol modification.