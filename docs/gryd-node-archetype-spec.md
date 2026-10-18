# Gryd node archetypes — design proposal

**Status: design only; not implemented, deployed, or authorized for live spending.**
This is a sibling to [Dogfood Attestation v1](gryd-attestation-spec.md), not a
replacement. The first slice lets a user bind a weather node to their own pin,
review and sign a prediction in their wallet, and have Gryd sponsor its exact
on-chain inscription. Traffic and crime are reserved stubs, not executable
archetypes. No UI, hardware, autonomous signer, reputation system or new wallet
implementation is included.

## 1. Evidence boundary and motivating proto-node

All statements about **current Gryd source** below refer to freshly fetched
`origin/dev` in `futureman19/the-grid`, pinned at
**`e6763c71f75a12acf8df3529e4ccc3fd50b16d80`** (abbreviated `GRID` only in prose).
The evidence appendix contains verbatim `git show <SHA>:<path>` excerpts with
original line ranges; labels E1–E12 are references to those quotations. The
entire current router is quoted, not inferred from an old checkout. A fetch used
`git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch
--no-tags origin +refs/heads/dev:refs/remotes/origin/dev` with terminal prompting
disabled. Only the remote-tracking ref was refreshed: no Gryd checkout, reset,
stash, source edit, deployment or remote write. Existing dirty Gryd files were
left alone. A source snapshot is not evidence of deployed configuration or live
route acceptance.

Dogfood source baseline is commit
`d56862df78cf0bc0ad9ec464b91c1c8fa5df496b`; local citations D1–D3 are explicitly
Dogfood, not evidence of the current backend. README, the sibling specification,
`src/gryd-attest.ts` and `src/gryd-agent.ts` were read before this design.

**User-supplied operational context:** “Gryd Weather Oracle”, `object:25`, is a
working proto-node with a publisher script and daily cron. That live assertion
is accepted as motivation, **not independently proven here**. Read-only searches
of committed Gryd source/docs and Dogfood `docs`, `scripts`, `src`, README found
no `object:25` or `Gryd Weather Oracle` publisher evidence. No real vault,
credentials, private cron directories or another profile's data were opened.
An archived weather-oracle example is not evidence of this instance. Therefore
no script path, schedule entry, last run, txid, current ownership or success rate
is invented. Generalize the *concept* (location + source + cadence + signed
history), not an uninspected operational deployment. `object:25` remains a
legacy source reference, not a new node ID or proof of ownership.

## 2. Contract decisions and rejected alternatives

| Decision | Chosen boundary | Rejected alternative and reason |
|---|---|---|
| Pin binding | `observation.payload.pin = "<origin-txid>.0"` | A new top-level `pin` breaks v1's exact seven-field observation schema (D1). |
| Data model | Weather payload profile `weather.prediction@1` inside v1 | A new attestation envelope would fork byte/signature verification unnecessarily. |
| Publication | User BSM signature, separate signed-write authorization, sponsor-funded exact ordinal | Backend signing as user confuses fee sponsorship with authorship; browser-crafted arbitrary transaction/script expands spending authority. |
| Identity | Compressed owner public key plus derived mainnet P2PKH address | Treating pubkey, payment address, sponsor address and named agent ID as interchangeable breaks identity binding. Current plug exposes a pubkey (E2), not an ownership certificate. |
| Lifecycle | Dedicated `node.*` actions and metadata registry | Reusing `agent.create` or an agent schedule suggests existing authorization and execution that this design does not establish. Current registries and routes are quoted in E3/E4/D3. |
| Discovery | Public indexed feed + client chain verification + raw-chain fallback | Pure index trust mistakes a database for authority; scanning chain alone is a poor bounded spatial discovery interface. |
| Trust | Show evidence/history and explicit verification states | No badges, reputation points or numeric truth score: signature correctness cannot prove a forecast correct. |

All contracts from section 3 onward are **proposed requirements**, unless a
sentence explicitly cites current source. Route/action additions are absent
from the pinned source; they are not examples of endpoints that work today.

## 3. Pin authority and node lifecycle

### Identity and ownership

`ownerPubkey` is canonical compressed secp256k1 lowercase hex (33 bytes).
`ownerAddress` is its base58check **mainnet P2PKH** address. Both request signatures
must recover this same key. Do not accept a caller's unsigned owner string or
infer authority from a sponsor input, database row, agent name or API content URL.
The current plug assigns `current_write_pubkey` after verification and consumes
a signed-write receipt (E2); the current pin controller derives an address and
compares it to `pin.owner_address`, and its transfer path invokes chain-tip
verification (E7). Those are useful seams, not proof that new node routes exist.

`pin` is the stable **origin** outpoint, strictly lowercase `[a-f0-9]{64}\.0`.
Only output-zero pin origins are supported in this slice. Never silently repair
`_0`, a malformed txid, or a nonzero vout in a signed payload. Indexer adapters
may convert their explicit underscore representation to the dot form *before*
validation/signing, preserving both raw provenance and normalized value.
`pinCurrentOutpoint` is separately `<lowercase-txid>.<nonnegative-vout>` with a
canonical decimal vout. Origin identity never changes when a pin transfers.

Before create/update/retire/publication, resolve raw origin and transfer lineage,
verify txids, referenced outputs, one-sat supported ownership scripts and fresh
current unspent evidence. Require the current tip's P2PKH controller to equal the
signer; lock/reload the registry revision and tip before reservation. Metadata
coordinates must equal the chain-derived pin coordinates exactly; unsupported
origin formats or uncertain lineage fail closed, not “best effort.” Record the
verified tip and chain observation time/block evidence. A UTXO/indexer response
is not independent SPV and cannot prevent a simultaneous transfer. Mark the
binding unknown/stale if chain reads fail; do not sponsor in that condition.

A transfer invalidates the old node's ability to publish against that pin. It
does **not** transfer the old author's identity/history or rewrite old signatures.
The new owner creates a new node ID for that origin. Old records remain readable
and can be marked `ownership_stale` as an index-derived status, separate from
owner-signed retirement. No delegated pin ownership, arbitrary identity-to-key
mapping or unattended wallet delegation is defined. If Yours' BSM signing key
is not the pin's controlling key, reject `OWNER_KEY_MISMATCH`; connection or JWT
identity does not cure that mismatch.

### Proposed registry record (not an on-chain NFT mint)

| Field | Rule / reason |
|---|---|
| `nodeId` | Client-selected UUID v4, lowercase; immutable, globally unique. Allows deterministic lookup after lost create response. |
| `pin` | Stable origin `txid.0`; immutable within this node. |
| `pinCurrentOutpoint` | Verified tip snapshot; updates only with fresh chain evidence, never caller authority. |
| `archetype` | Exactly `weather.prediction@1` for this slice; immutable. Version change means new node ID. |
| `config` | Closed weather configuration: metric, sourceRefs, modelRef, resolution rule, baseline rule, cadence; bounded below. |
| `sourceRefs` | One to eight inert, credential-free references (1–1024 UTF-8 bytes each), matching config; no backend arbitrary URL fetch. |
| `cadence` | `{kind:"daily",hourUtc:0..23}` or `{kind:"manual"}`. An expectation/reminder, not permission to sign. |
| `ownerAddress`, `ownerPubkey` | Derived mainnet P2PKH and verified BSM key; immutable per node. |
| `revision` | Positive integer, starts at 1; optimistic concurrency and immutable snapshot lookup. |
| `createdAt`, `updatedAt` | Server UTC timestamps; distinguish record lifecycle from observed/target/chain time. |
| `retiredAt` | Null or terminal UTC time; retirement stops new publications, never deletes history. |
| `configHash` | Lowercase SHA-256 of UTF-8 canonical config, so inscriptions can bind a particular immutable snapshot. |

`config` is a closed object with exactly `{metric,unit,sourceRefs,modelRef,
resolutionSourceRef,resolutionRule,baselineMethod,targetHourUtc,cadence}`:
metric is `air_temperature_2m`, unit `Cel`, resolutionRule
`nearest-sample-earlier-on-tie@1`, baselineMethod `persistence`; targetHourUtc is
an integer 0..23 and the target is that hour on the UTC day after `slot`.
modelRef/resolutionSourceRef are inert strings of 1..1024 UTF-8 bytes;
resolutionSourceRef must occur in sourceRefs. Cadence has exactly the shape in
the table; no scripts, secrets, arbitrary fetch options or extension fields.
Registry sourceRefs and cadence are projections of config, not separately
editable competing values. A prediction must match this revision's metric,
unit, model, source/resolution rules and target hour; the baseline and evidence
values remain signed publication data, not mutable configuration.

Store each revision append-only with the signed mutation envelope and verified
actor/tip evidence. The current-row projection is mutable convenience; old
revisions and publication references are immutable. Store `ownershipStatus` and
`ownershipCheckedAt` as derived index evidence, not signed user assertions.
A bounded display label could be added in a later revision; it is unnecessary
for this first contract. No balance, score, badge or executable script field.

`node.create` takes exactly `{requestId,nodeId,pin,archetype,config}`; derive owner,
coordinates and timestamps. `node.update` takes exactly
`{requestId,expectedRevision,config}` at its node path. It changes config/cadence
only, not owner/pin/archetype. `node.retire` takes exactly
`{requestId,expectedRevision}`. A successful mutation returns
`{node,requestId,operationStatus:"committed"}`; reusing a requestId with different
canonical content is a conflict. Concurrent revisions fail `REVISION_CONFLICT`.
Readback must retrieve the exact returned revision, not just the current row.

## 4. Weather payload profile, without changing Attestation v1

Propose shared, dependency-light validators and schema material under
`packages/locus-protocol` for **`weather.prediction@1`**. This is an intended
package destination, not an existing exported schema. The generic v1 verifier
continues to accept other valid namespaced types and `weather.reading` without
pretending that they satisfy this new prediction profile (D1/D2).

The observation retains exactly `type,lat,lng,observedAt,source,payload,agent`.
For this profile, `type` is `weather.prediction`; `payload.profile` is exactly
`weather.prediction@1`; `agent.id` equals nodeId and `agent.ownerAddress` equals
the signing key's mainnet P2PKH address. No new top-level fields are allowed.
The proposed payload, expressed in JSON-schema-like notation, is closed
(`additionalProperties:false`), with all fields required except `correctionOf`:

```text
profile: const "weather.prediction@1"
pin: string matching ^[a-f0-9]{64}\.0$
nodeRevision: integer >= 1
configHash: lowercase SHA-256 hex
slot: canonical UTC date YYYY-MM-DD (prediction issue day)
issuedAt: calendar-valid UTC YYYY-MM-DDTHH:mm:ss.sssZ
pinCurrentOutpoint: canonical txid.vout snapshot
prediction: {
  metric: const "air_temperature_2m",
  value: finite number in [-100, 100], unit: const "Cel",
  targetAt: canonical UTC instant,
  aggregation: const "instant", modelRef: bounded inert string
}
baseline: {
  method: const "persistence", value: finite number in [-100, 100],
  unit: const "Cel", observedAt: canonical UTC instant,
  evidence: {ref: bounded inert string, sha256: lowercase SHA-256 hex}
}
resolution: {
  sourceRef: bounded inert string,
  metric: const "air_temperature_2m", unit: const "Cel",
  targetAt: canonical UTC instant, toleranceSeconds: const 1800,
  rule: const "nearest-sample-earlier-on-tie@1"
}
evidence: [{ref: bounded inert string, sha256: lowercase SHA-256 hex}] (1..8)
correctionOf?: canonical original attestation mint txid.0
```

Apply v1's existing 32,768-byte canonical observation, 4096-value, depth-16,
plain-JSON/UTF-8 limits first (D1); every nested profile object is also closed.
Strings use the sibling spec's control-character and credential-free reference
rules. Coordinates are finite lat ±90/lng ±180, identical to the node's pin,
not rounded by a signer or server. Only temperature is implemented by this
profile proposal: reject rainfall, wind or unit conversions rather than
silently mixing units. Bounds are validation policy, not proof of plausibility.

`observedAt` means when the source inputs were observed, **not** the future
forecast target. Require `baseline.observedAt <= observedAt <= issuedAt <
prediction.targetAt`, `resolution.targetAt == prediction.targetAt`, target no
more than 48 hours after issuedAt, and slot equal to issuedAt's UTC date. Require
publication intent receipt before targetAt, issuedAt not in the server's future
beyond 300 seconds, and observedAt no more than 24 hours before issuedAt.
These are additional profile/publication rules; generic v1 permits historical
and future observedAt values and must not be tightened globally (D1).

The signature attests asserted timestamps, not an independently trusted clock.
Only a sufficiently early on-chain anchor establishes that bytes existed before
the target: label a prediction “late/unproven-pre-target” if its independently
checked chain inclusion is not before targetAt, even if the API received it
earlier. A sponsor receipt cannot manufacture advance prediction evidence.

Source refs identify versioned model/input material, not just a mutable homepage.
Digest the exact archived source response bytes; preserve source measurement
coordinates/times and fetch time in that referenced artifact. Baseline persistence
uses the declared latest observation available at issuedAt; retain evidence so
later clients can challenge that claim. Resolution is the closest sample from
the predeclared source within ±1800 seconds, earlier sample wins a tie; reject
samples at other coordinates/units. If no valid sample or preserved evidence
exists, status is `unresolved`, never a fabricated actual value. Show predicted,
baseline and resolved measured temperature side by side with provenance; do not
convert this into a reputation score. A separate future resolution publication
profile would need its own versioned contract; v1 does not silently add one.
Read-only consumers may verify resolution evidence without a new server signer.

**Compatibility:** existing `weather.reading` remains valid generic attestation
data. Do not auto-upgrade a temperature reading into a forecast, add a missing
pin after signing, or wrap old bytes differently. Historical readings without
this profile may appear only as explicitly legacy/unprofiled records and cannot
satisfy the node prediction contract. Traffic and crime identifiers are reserved
for future specification: no payload schema, scheduler, sponsor eligibility or
truth claim is supplied. In particular, this design does not solicit personal
crime accusations or persistent sensitive-location trails.

## 5. Two signature domains and the browser-to-sponsor boundary

1. The web client constructs and validates the complete observation against a
   particular node revision. It displays the pin, owner, source, target time,
   public permanence and exact prediction for approval. It calls the wallet's
   BSM `signMessage` on `Dogfood Attestation v1\n + canonicalJson(observation)`.
2. Build `{observation,pubkey,signature}` exactly as v1. The compact base64
   signature is 65 bytes, canonical 88-character encoding ending `=`, compressed
   recovery header 31–34. Validate ECDSA **and recovered key/header**, compressed
   lowercase pubkey, mainnet address equality, full schema and exact bytes (D2).
3. Request a second wallet BSM signature on `Locus Signed Write\n +
   canonicalJson(payload)`. The proposed payload is
   `{mode:"signed_write",method:"POST",path:"/api/v1/nodes/<nodeId>/attestations",
   action:"node.attest",body:{requestId,nodeRevision,attestation},timestamp,nonce,
   network:"mainnet",audience:"the-grid-api.fly.dev"}`. The nonce is fresh random
   UUID, timestamp integer Unix seconds; no arbitrary host/network overrides.
   The **entire signed attestation wrapper** is inside the signed body. The
   exact path, method, node revision and requestId are bound too. Transport is
   `{payload,signature,pubkey}`; no unsigned owner/script/fee override.
4. The proposed route runs the signed-write plug and strict action check, verifies
   both domains, requires identical recovered keys, derives ownerAddress, checks
   revision/configHash/profile/pin authority, then reserves sponsorship. It must
   never infer that a valid attestation also authorizes an HTTP mutation.
5. The sponsor signs **only its funding transaction inputs**, constructs output
   zero as the exact v1 one-sat inscription locked to the attestation signer
   address, and returns its own change. It neither edits nor authors the signed
   observation. The user's pin is referenced, **not spent** to publish.

Current wallet API evidence matters: `useLocusWallet` exposes
`signMessage(msg: string): Promise<{address,pubKey,sig,message}|null>` and calls
`signBsm.execute(ctx,{message:msg})`; its source says the legacy `window.yours`
global was removed (E6). “Yours signMessage” here means this current wallet
abstraction with Yours connected, **not** invented `window.yours.signMessage`
arguments. Reject decline/null, a returned message different from requested
bytes, incompatible compact encoding, a recovered key mismatch, or an identity
key that does not own the pin. Do not assume BRC-100 identityPubKey equals the
message signing key. Browser-wallet compatibility requires future fixtures and
actual consent-path verification; this design does not claim that test happened.

The exact inscription content is
`JSON.stringify({observation:JSON.parse(canonicalJson(validatedObservation)),pubkey,signature})`
in that wrapper insertion order. Signature canonical JSON sorts keys directly,
recursively, preserving arrays; it is **not** JSON.stringify of a reconstructed
sorted object (numeric keys reorder). Use unchanged v1 serializer semantics,
ECMAScript number encoding, no Unicode normalization, no CR/BOM or extra newline.
Transport JSON is deliberately different from canonical signature bytes.
Rebuild the whole `OP_FALSE OP_IF "ord" OP_1 "application/json" OP_0 <UTF8 content>
OP_ENDIF <signer P2PKH>` script byte-for-byte; no suffix stripping, additional
outputs hidden as fees, alternate pushes or client-supplied scripts (D2).

The two prefixes remain distinct. Current WriteEnvelope verifies timestamp,
method/path, nonce, network and audience; its audience is configured, not proven
by a source default (E1). Proposed production scope above must match deployed
configuration. Current TS helper and complete action registry are quoted in E3;
byte parity across JavaScript and Elixir must be validated for this bounded
profile before rollout, not assumed from comments alone.

## 6. Minimal sponsored-publication changes and durability

**Current dispatch, not proposed capability:** the script allowlist is `place`,
`mint`, `heartbeat`, `imported_nft`, `agent_payout` (E5). `mint` requires an owner;
`mint/place/imported_nft` pay a plain one-sat P2PKH output and append OP_RETURN;
`heartbeat` is not in `paysOwner` and uses the generic non-mint payload branch;
`agent_payout` has a distinct payout/receipt branch that can convert a pubkey to
an address (E5). None builds the exact Dogfood attestation ordinal. Moreover,
public sponsored eligibility lists only `place,mint,heartbeat,imported_nft`
(E9); the script's internal payout action does not imply public permission.
The existing controller separates `sponsorship.broadcast` authorization from
its inner sponsored action and invokes `broadcast_and_account` (E8).

**Required additions, not work performed here:**

- Add `node.create`, `node.update`, `node.retire`, `node.attest` to the shared
  `SIGNED_WRITE_ACTIONS`/`SignedWriteAction` union (E3); introduce a narrow node
  controller/context with exact action-to-route checks and revision persistence.
  `VerifySignedWrite` supplies authentication, not this action registry or pin
  authorization; its verified assignments are quoted in E2. Use its signed body
  exclusively. Reject missing action rather than copying permissive fallbacks.
- Add an internal sponsored builder action named `attestation` and explicit
  server eligibility/budget handling. Do **not** reinterpret existing `mint`,
  `heartbeat`, `agent_payout` or general `sponsorship.broadcast` as permission.
  Prefer only the new node route as the public entry point; do not expose the
  new inner action through the generic sponsorship controller without equivalent
  node validation. Existing public eligibility must remain closed otherwise.
- Extend `sponsored_broadcast.js` with one fixed exact wrapper/script constructor,
  bounded attestation/schema/recovery verification, owner derivation, one-sat
  output zero, sponsor-only funding and change, actual fee ceiling, and signed
  evidence persistence **before** dispatch. Pass typed verified attrs only;
  never accept raw locking scripts, user WIFs, destination overrides or signing
  code. Do not import keys from Yours/Dogfood. The current script's input is a
  server sponsor key passed by its caller (E10); protect that existing boundary.
- Current script `broadcast` catches failures and retries up to four times (E5).
  The new action must not inherit blanket retries: introduce a narrow single-shot
  submission/reconciliation boundary for it, without accidentally changing other
  action semantics. A timeout or non-definitive error retains the exact signed
  transaction and hold; no rebuilding or selecting new coins to “try again.”
- Add durable operation, slot, revision and evidence storage, a read-only receipt
  route, public feed indexing and client verification. Existing nonce replay
  rejection (E2) is necessary but **not** durable business idempotency or evidence
  that this publication completed. Dogfood `AGENT_WRITE_ACTIONS` is an agent-only
  subset (D3): keep it unchanged. A future explicit node client is separate; do
  not add node actions to `agent-call`, rename them `agent.*`, or imply MCP support.

### Reservation and evidence state machine

Proposed order: validate both signatures and all bounded schema → verify current
pin authority → acquire sponsor-wide exclusive coin/budget lock → transactionally
reserve unique requestId, publication slot, budget and funding outpoints → persist
intent → build/check/sign → durably persist exact raw bytes/expected txid → mark
submission started → submit once → independently read raw tx and public receipt →
account once → release only the execution lock for a verified terminal outcome.
The durable exposure reservation survives a released/abandoned process lock.
No lock stealing by age/PID and no automatic hold expiry; multi-host workers need
a database/transactional lock, not a per-browser mutex.

Budget proposal: operator-configured per-publication fee cap, per-owner UTC-day
publication count and satoshi cap, and sponsor-wide UTC-day satoshi cap. Charge
**actual miner fee plus the one-sat owner output** to sponsor exposure, reserving
a safe maximum before signing; do not call the gifted output a miner fee. Reject
missing limits and zero budgets. Verify all funding raw tx hashes, values, scripts,
fresh unspent status, safe sums, exact output roles and all transaction input
signatures. Sponsor funding must exclude protected ordinals/one-sat coins. No
client fee cap may increase operator limits. A user signs authorship and request,
not sponsor input authority or a promise of payment for the data.

Durable private evidence includes request digest, both signed envelopes, node
revision/config hash, verified pin tip and evidence time, policy/budget snapshot,
funding outpoints, immutable signed tx/expected txid, submission attempt, sanitized
transport result, chain readback and exactly-once accounting marker. Keep secrets
out; signed requests/raw txs are sensitive authorizations even without keys.
Failures remain append-only events, not overwrites. Lost response, process death,
wrong returned txid, readback mismatch, persistence failure, or uncertain chain
state yields `held`/`unknown`, never “failed safely, retry.” Human reconciliation
uses original bytes/known txid and accounting evidence; never clear holds just
to create another transaction. Receipt storage must exist before dispatch so a
client need not guess a txid discovery endpoint.

### Slot policy, idempotency and corrections

Normal slot key is `(ownerPubkey,nodeId,profile,slot)`; revision changes do not
reset the daily slot. One prediction per UTC issue day per node; config defines
the exact target-time selection. requestId is a UUID business identifier independent
of the short-lived signed-write nonce. Persist SHA-256 of canonical
`{nodeId,nodeRevision,attestation}` as content identity. Same requestId + different
content is `IDEMPOTENCY_CONFLICT`; same normal slot + different content is
`SLOT_CONFLICT`. Same content and slot, even with a new requestId, resolves to the
same persisted operation and txid, not a second inscription or fee charge.

An exact replayed HTTP signature may currently be rejected by the plug (E2), so
clients recover by **GET receipt**, not automatic POST replay. Following a known
pre-dispatch definitive rejection, a deliberate new attempt needs fresh nonce,
timestamp and signature while retaining the business requestId/content identity.
The new controller must perform that idempotent lookup after authentication,
before any sponsor reservation. Ambiguous old attempts never become new ones.

Corrections use the same profile with `correctionOf` naming an earlier verified
mint outpoint by the same node/owner; append, never replace the original. At most
one direct correction per referenced outpoint; later correction refers to the
previous correction, with cycles and cross-node references rejected. Treat its
publication slot as `(normal slot,correctionOf)` and charge normal quotas. Keep
the original slot/target; prohibit changing target to evade a failed prediction.
Post-target correction of a forecast value is rejected: record a visible error
in registry/audit metadata instead, not a new “successful forecast.” An index can
mark superseded/error states, but must preserve every original byte and show the
correction chain. A metadata edit cannot fix an immutable inscription.

## 7. Proposed route matrix and collision review

These **new** routes were checked against **all 262 lines** of the current router
(E4), including dynamic segments and wildcard pin-prefix routes, not merely a
search for the word “node.” Existing scopes include public `/api/v1`, signed
`/api/v1`, public/signed `/v2`, and `/api/v2/inscriptions`; exact route groups are
quoted in E4. `/api/v1/nodes` and `/api/v1/node-publications` have no current
matching route or catch-all. Do not reuse `/agents/:id`, `/objects/mint`,
`/sponsorship/broadcast` or `/v2/pins/:txid` to disguise the new contract.

| Method / proposed path | Authorization / signed action | Request / response |
|---|---|---|
| POST `/api/v1/nodes` | signed `node.create` | Section 3 body → 201 registry record/requestId |
| PUT `/api/v1/nodes/:nodeId` | signed `node.update` | expectedRevision/config → 200 new revision |
| POST `/api/v1/nodes/:nodeId/retire` | signed `node.retire` | expectedRevision → 200 retired revision |
| POST `/api/v1/nodes/:nodeId/attestations` | signed `node.attest` | Section 5 body → 202 durable publication receipt |
| GET `/api/v1/nodes` | public | bounded discovery query below → items/cursor |
| GET `/api/v1/nodes/:nodeId` | public | optional revision integer ≥1 → exact revision or 404 |
| GET `/api/v1/nodes/:nodeId/attestations` | public | bounded history query below → items/cursor |
| GET `/api/v1/node-attestations` | public | bounded cross-node feed below → items/cursor |
| GET `/api/v1/node-publications/:requestId` | public sanitized | durable receipt, no signed HTTP authorization or private funding evidence |

Route audit also includes the distinct feed prefix `/api/v1/node-attestations`;
none of the three proposed namespace roots exists in E4. Register static reads
before any future generic node wildcard. IDs are UUIDs, not arbitrary decoded
paths; reject slashes, percent escapes and dot segments. Signed path equals the
actual canonical path, uppercase method, no write query parameters. Return stable
400 `INVALID_REQUEST`, 401 `INVALID_SIGNATURE`, 403 `NOT_PIN_OWNER`, 404
`NOT_FOUND`, 409 `REVISION_CONFLICT`/`STALE_PIN_BINDING`/`SLOT_CONFLICT`/
`IDEMPOTENCY_CONFLICT`/`PUBLICATION_HELD`, 422 `INVALID_PROFILE`/
`OWNER_KEY_MISMATCH`, 429 `SPONSOR_BUDGET_EXHAUSTED`, 503 `CHAIN_UNAVAILABLE` or
`SPONSOR_UNAVAILABLE`. Structured errors carry requestId and retryability=false
unless a *definitive pre-dispatch* transient refusal is specifically established.
Never leak provider bodies, key material or signing requests in public errors.

Proposed receipt:
`{requestId,nodeId,nodeRevision,contentHash,slot,status,txid:null|string,
attestationOutpoint:null|string,feeSats:null|integer,createdAt,updatedAt,errorCode:null|string}`.
States are `reserved`, `signed`, `submitted`, `acknowledged`, `verified`,
`rejected_before_dispatch`, `held_unknown`. Include the immutable expected txid
as soon as known; acknowledgement is not confirmation. Readback of `verified`
must match request, signed wrapper hash, exact output-zero destination/script,
actual txid and durable accounting. Display confirmation evidence separately,
with checkedAt/block height/hash or `unknown`; a later reorg changes derived
chain status, not receipt history. Never advertise the new GET as available now.

## 8. Public discovery, pagination and trust

Use indexed API discovery, then independently verify each selected transaction.
Proposed query contract is closed: reject duplicate/unknown parameters, invalid
numbers or malformed cursors, and impose request/response byte limits.

- `GET /nodes`: optional `archetype` (exact `weather.prediction@1`), `pin`
  (canonical origin), `bbox`, `cursor`, `limit`. Always return owner/retired/stale
  status; no implied active-only filter. Sort `(createdAt,nodeId)` ascending.
- Global `GET /node-attestations`: require `from` and `to` canonical UTC instants,
  with `from < to`, window ≤31 days, inclusive lower/exclusive upper on
  **issuedAt**, not observation target time; optional `nodeId`, exact `archetype`,
  `bbox`, `limit`, `cursor`. Filters combine by AND.
- Per-node history: same `from,to` window and pagination, with nodeId fixed by
  path; no second nodeId parameter. Full history is obtained through successive
  explicit windows, not an unbounded endpoint. Retired/stale nodes remain readable.
- `bbox=west,south,east,north`: four finite decimal degrees; west/east within
  [-180,180], south/north [-90,90], west < east, south < north, maximum 5 degrees
  on each axis. All four spatial edges inclusive. Antimeridian crossing requires
  two requests and client deduplication; never guess a wrapped box.
- `limit` integer 1..100, default 50. Opaque authenticated cursor ≤2048 bytes
  binds filter hash, snapshot upper ingestion sequence and last ordering tuple;
  it is not authorization. Snapshot excludes later ingests until a new traversal.
  Reject cursor/filter mismatch with 400 and expired snapshot with 410.
- Attestation order is `(issuedAt,txid,vout)` ascending. Deduplicate by immutable
  mainnet mint outpoint `(txid,0)`, not author/timestamp, node revision or current
  ownership tip. Late arrivals appear on a new traversal; client deduplicates
  overlapping windows/snapshots. Return `{items,nextCursor,snapshot,complete}`;
  do not claim chain completeness just because nextCursor is null.

Each feed item carries exact wrapper or its bounded locator plus wrapper hash,
origin txid/vout, nodeId/profile/revision/configHash, pin origin/tip snapshot,
issuer key/address, issuedAt/observedAt/targetAt, index ingestion time and source.
Separate statuses for schema/signature validity, pin authorization evidence at
publication, current pin binding, chain raw-byte verification, mempool/confirmed/
reorg/unknown, and resolution evidence availability. Include checkedAt and
provider/block provenance. These are evidence dimensions, not badges or scores.
`authentic:true` alone never means accurate weather or a trustworthy source.
Node metadata is an index: verify the signed payload's immutable reference,
not whatever config the mutable latest row happens to contain.

**Current source comparison:** the pinned backend `OneSat` client uses
`https://api.1sat.app`, an owner-txo SSE path with `unspent=true`, and
`https://api.1sat.app/content` (E11). The pinned web CDN constants likewise name
1sat.app (E12). Do not advertise stale `ordinals.gorillapool.io` locators from
historical Dogfood examples as this backend's current weather feed. GorillaPool
or another ordinal indexer could be an optional discovery/content provider,
but no existing weather/archetype/bbox endpoint is established by this review.
The current owner-unspent API is not an append-only observation-history API:
transferred/spent attestations must not disappear from history. Raw-chain
fallback can fetch a **known** txid using the source-backed WoC raw transaction
path (E5), hash-check and decode its complete script/signature; it does not solve
unknown-txid spatial discovery. A chain client verifies evidence, not the
scientific truth of an input. If indexers disagree or are unavailable, expose
partial/unknown discovery, use known receipt txids for read-only verification,
and never fabricate an empty authoritative history or substitute an API row for
transaction bytes. No live provider availability or SPV acceptance was tested.

## 9. Cadence, earning and explicit non-goals

A daily cadence expresses when the user intends to publish. A browser reminder
may construct a new observation, but **each publication needs fresh user wallet
signatures** for the actual data and HTTP authorization. The backend cannot
observe tomorrow's weather and sign as the owner using yesterday's permission.
The user-described local publisher/cron may have its own explicitly controlled
signer, but that does not prove unattended Yours authorization. Delegation,
pre-signed future observations, autonomous key custody and background wallet
approval are out of scope. Missed days remain visible gaps, not synthetic entries.

Revenue sketch only: a consumer could later pay sats for retrieval, subscriptions
or explicitly commissioned predictions through a separately reviewed x402 offer;
a transparent optional service split would need an owner-approved amount,
destination and independently checkable receipt, while sponsor fees remain a
separate cost. No payout, split percentage, escrow, automatic entitlement or
x402 route is implemented or promised here; publishing a correct signature does
not itself earn sats, and Dogfood's existing no-built-in-revenue policy is unchanged.

## 10. Design validation and readiness

This document is the only repository change. Validation is source/contract review,
**not TDD or implementation testing**: fetch/pin, extract numbered git blobs,
compare every appendix quote to its blob, inspect the full route table, check
proposed route absence/collisions and registry absence, verify local links and
`git diff --check`. No package changes, test changes, builds, wallet execution,
vault access, broadcast, API mutation or deployment was performed. No tests are
invented or claimed green. Static audit result: **25 verbatim quote blocks across
15 source entries matched their immutable git blobs; 135 existing route
declarations across the complete 262-line router were checked against all nine
proposed method/path pairs, with zero collisions; all four new node actions were
absent from the current shared registry.** Local document links, fenced blocks
and whitespace checks passed. These counts describe document validation, not
application tests or endpoint execution.

Ready for implementation planning after review, **not ready for production**.
Required gates: shared profile and cross-language byte fixtures; real Yours
consent/key/compact-signature compatibility; strict node controllers and current
chain authority validation; exact sponsor builder and bounded fees; transactional
holds/idempotency/receipt readback; append-only revision/history index; negative
cases for transfers, signature-header tampering, same-slot conflicts, process
failure and ambiguous broadcasts; offline intercepted execution before any
separately authorized funded acceptance. The live proto-node's script/cron remains
unverified; obtaining its sanitized public artifacts is optional provenance work,
not permission to read private schedules or keys.

## Source evidence appendix

Each `E` quotation below is copied verbatim from the **same pinned GRID commit**;
line ranges refer to original files, not this document. Full registry and router
quotations support absence claims; proposal prose is intentionally not presented
as source. `D` quotations are separately pinned Dogfood source. Quoted source
comments are evidence of what source says, not independent runtime proof.

### E1 — `locus-mobile/backend/locus_api/lib/locus_api/write_envelope.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 1–213:

```elixir
defmodule LocusApi.WriteEnvelope do
  @moduledoc """
  Canonicalizes signed-write payloads so client and server sign the same bytes.
  """

  @message_prefix "Locus Signed Write\n"
  @max_clock_skew_seconds 300
  @nonce_pattern ~r/\A[A-Za-z0-9._~-]{16,128}\z/

  def parse(payload) when is_map(payload), do: {:ok, stringify_keys(payload)}

  def parse(payload) when is_binary(payload) do
    case Jason.decode(payload) do
      {:ok, decoded} when is_map(decoded) -> {:ok, stringify_keys(decoded)}
      _ -> {:error, :invalid_payload}
    end
  end

  def parse(_), do: {:error, :invalid_payload}

  def canonical_message(payload) do
    with {:ok, parsed} <- parse(payload) do
      {:ok, @message_prefix <> IO.iodata_to_binary(canonical_json(parsed))}
    end
  end

  def validate_timestamp(payload) when is_map(payload) do
    case int_value(payload["timestamp"]) do
      nil ->
        {:error, :missing_timestamp}

      timestamp ->
        now = DateTime.utc_now() |> DateTime.to_unix()

        if abs(now - timestamp) <= @max_clock_skew_seconds do
          :ok
        else
          {:error, :stale_timestamp}
        end
    end
  end

  def validate_timestamp(_), do: {:error, :missing_timestamp}

  def validate_request(payload, method, path) when is_map(payload) do
    with :ok <- validate_mode(payload["mode"]),
         :ok <- validate_method(payload["method"], method),
         :ok <- validate_path(payload["path"], path),
         :ok <- validate_nonce(payload["nonce"]),
         :ok <- validate_network(payload["network"]),
         :ok <- validate_audience(payload["audience"]),
         body when is_map(body) <- payload["body"] do
      :ok
    else
      nil -> {:error, :missing_body}
      false -> {:error, :invalid_body}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_body}
    end
  end

  def validate_request(_, _, _), do: {:error, :invalid_payload}

  def action(payload) when is_map(payload), do: normalized_string(payload["action"])
  def action(_), do: nil

  def body(payload) when is_map(payload) do
    case payload["body"] do
      body when is_map(body) -> stringify_keys(body)
      _ -> %{}
    end
  end

  def body(_), do: %{}

  defp validate_mode("signed_write"), do: :ok
  defp validate_mode(_), do: {:error, :invalid_mode}

  defp validate_method(value, request_method) when is_binary(value) do
    if String.upcase(String.trim(value)) == String.upcase(to_string(request_method)),
      do: :ok,
      else: {:error, :method_mismatch}
  end

  defp validate_method(_, _), do: {:error, :missing_method}

  defp validate_path(value, request_path) when is_binary(value) and is_binary(request_path) do
    if normalize_path(value) == normalize_path(request_path),
      do: :ok,
      else: {:error, :path_mismatch}
  end

  defp validate_path(_, _), do: {:error, :missing_path}

  defp normalize_path(path) do
    path
    |> URI.decode()
    |> String.trim_trailing("/")
  end

  defp validate_nonce(value) when is_binary(value) do
    if Regex.match?(@nonce_pattern, value), do: :ok, else: {:error, :invalid_nonce}
  end

  defp validate_nonce(_), do: {:error, :missing_nonce}

  def expected_network do
    to_string(Application.get_env(:locus_api, :signed_write_network, "mainnet"))
  end

  def expected_audience do
    case Application.get_env(:locus_api, :signed_write_audience) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp validate_network(value) do
    cond do
      is_nil(value) or value == "" ->
        {:error, :missing_network}

      not is_binary(value) ->
        {:error, :invalid_network}

      value not in ["mainnet", "testnet"] ->
        {:error, :invalid_network}

      value != expected_network() ->
        {:error, :network_mismatch}

      true ->
        :ok
    end
  end

  defp validate_audience(value) do
    expected = expected_audience()

    cond do
      is_nil(expected) ->
        {:error, :audience_unconfigured}

      is_nil(value) or value == "" ->
        {:error, :missing_audience}

      not is_binary(value) ->
        {:error, :invalid_audience}

      value != expected ->
        {:error, :audience_mismatch}

      true ->
        :ok
    end
  end

  defp stringify_keys(map) when is_map(map) do
    map
    |> Enum.map(fn {key, value} -> {to_string(key), stringify_value(value)} end)
    |> Map.new()
  end

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value) when is_list(value), do: Enum.map(value, &stringify_value/1)
  defp stringify_value(value), do: value

  defp canonical_json(map) when is_map(map) do
    entries =
      map
      |> Enum.sort_by(fn {key, _value} -> key end)
      |> Enum.map(fn {key, value} ->
        [Jason.encode!(key), ?:, canonical_json(value)]
      end)
      |> Enum.intersperse(?,)

    [?{, entries, ?}]
  end

  defp canonical_json(list) when is_list(list) do
    values =
      list
      |> Enum.map(&canonical_json/1)
      |> Enum.intersperse(?,)

    [?[, values, ?]]
  end

  defp canonical_json(value), do: Jason.encode!(value)

  defp normalized_string(value) when is_binary(value) do
    value
    |> String.trim()
    |> case do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalized_string(_), do: nil

  defp int_value(value) when is_integer(value), do: value
  defp int_value(value) when is_float(value), do: trunc(value)

  defp int_value(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp int_value(_), do: nil
end
```

### E2 — `locus-mobile/backend/locus_api/lib/locus_api_web/plugs/verify_signed_write.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 1–157:

```elixir
defmodule LocusApiWeb.Plugs.VerifySignedWrite do
  @moduledoc """
  Resolves a write actor from a signed payload.
  """

  import Plug.Conn

  alias LocusApi.{Accounts, SignedWriteReceipt}
  alias LocusApi.Auth.SignatureVerifier
  alias LocusApi.WriteEnvelope

  @wrapper_fields ~w(payload signature pubkey public_key address)

  def init(opts), do: opts

  def call(conn, _opts) do
    cond do
      signed_write?(conn.params) ->
        verify_signed_write(conn)

      true ->
        unauthorized(conn, "Signed write required")
    end
  end

  defp verify_signed_write(conn) do
    with {:ok, payload} <- WriteEnvelope.parse(conn.params["payload"]),
         :ok <- WriteEnvelope.validate_timestamp(payload),
         :ok <- WriteEnvelope.validate_request(payload, conn.method, conn.request_path),
         :ok <- reject_unsigned_fields(conn),
         action when is_binary(action) <- WriteEnvelope.action(payload),
         signature when is_binary(signature) and signature != "" <- conn.params["signature"],
         pubkey when is_binary(pubkey) and pubkey != "" <-
           conn.params["pubkey"] || conn.params["public_key"],
         {:ok, message} <- WriteEnvelope.canonical_message(payload),
         {:ok, verified_pubkey} <-
           SignatureVerifier.verify_bsv_signature_with_pubkey(message, signature, pubkey),
         :ok <- SignedWriteReceipt.consume_once(message, verified_pubkey, action),
         {:ok, user} <- Accounts.ensure_user(%{public_key: verified_pubkey}) do
      body = WriteEnvelope.body(payload)
      verified_params = Map.merge(body, conn.path_params || %{})

      conn
      |> Map.put(:params, verified_params)
      |> Map.put(:body_params, body)
      |> assign(:current_user, user)
      |> assign(:current_write_payload, payload)
      |> assign(:current_write_body, WriteEnvelope.body(payload))
      |> assign(:current_write_pubkey, verified_pubkey)
      |> assign(:current_write_action, action)
    else
      nil ->
        unauthorized(conn, "Signed write action is required")

      {:error, :missing_timestamp} ->
        unauthorized(conn, "Signed write timestamp is required")

      {:error, :stale_timestamp} ->
        unauthorized(conn, "Signed write timestamp is stale")

      {:error, :missing_method} ->
        unauthorized(conn, "Signed write HTTP method is required")

      {:error, :method_mismatch} ->
        unauthorized(conn, "Signed write HTTP method does not match request")

      {:error, :missing_path} ->
        unauthorized(conn, "Signed write path is required")

      {:error, :path_mismatch} ->
        unauthorized(conn, "Signed write path does not match request")

      {:error, reason} when reason in [:missing_nonce, :invalid_nonce] ->
        unauthorized(conn, "Signed write nonce is required and must be random")

      {:error, :missing_network} ->
        unauthorized(conn, "Signed write network is required")

      {:error, :invalid_network} ->
        unauthorized(conn, "Signed write network is invalid")

      {:error, :network_mismatch} ->
        unauthorized(conn, "Signed write network does not match this deployment")

      {:error, :missing_audience} ->
        unauthorized(conn, "Signed write audience is required")

      {:error, :invalid_audience} ->
        unauthorized(conn, "Signed write audience is invalid")

      {:error, :audience_mismatch} ->
        unauthorized(conn, "Signed write audience does not match this deployment")

      {:error, :audience_unconfigured} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(:service_unavailable, Jason.encode!(%{error: "Signed write audience is not configured"}))
        |> halt()

      {:error, reason} when reason in [:invalid_mode, :missing_body, :invalid_body] ->
        unauthorized(conn, "Signed write payload is invalid")

      {:error, :unsigned_fields} ->
        unauthorized(conn, "Unsigned request fields are not allowed")

      {:error, :replayed_write} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(:conflict, Jason.encode!(%{error: "Signed write has already been consumed"}))
        |> halt()

      {:error, :invalid_payload} ->
        unauthorized(conn, "Signed write payload is invalid")

      {:error, :node_not_available} ->
        conn
        |> send_resp(
          :internal_server_error,
          Jason.encode!(%{error: "Signature verifier is unavailable"})
        )
        |> halt()

      {:error, {:verifier_failed, _status, _output}} ->
        unauthorized(conn, "Signed write verification failed")

      {:error, reason} when is_binary(reason) ->
        unauthorized(conn, reason)

      false ->
        unauthorized(conn, "Signed write verification failed")

      _ ->
        unauthorized(conn, "Signed write verification failed")
    end
  end

  defp signed_write?(params) when is_map(params) do
    is_map(params["payload"]) or is_binary(params["payload"])
  end

  defp signed_write?(_), do: false

  defp reject_unsigned_fields(%Plug.Conn{body_params: params}) when is_map(params) do
    if Enum.all?(Map.keys(params), &(to_string(&1) in @wrapper_fields)),
      do: :ok,
      else: {:error, :unsigned_fields}
  end

  defp reject_unsigned_fields(_), do: :ok

  defp unauthorized(conn, message) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(:unauthorized, Jason.encode!(%{error: message}))
    |> halt()
  end
end
```

### E3 — `packages/locus-protocol/src/signed-write.ts`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 30–158:

```ts
export const SIGNED_WRITE_MESSAGE_PREFIX = 'Locus Signed Write\n';
export const SIGNED_WRITE_MODE = 'signed_write';

/** Max clock skew between client and server (matches backend `WriteEnvelope`). */
export const SIGNED_WRITE_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Action names accepted by the backend. Mirror these on the wire
 * exactly — the backend `ensure_action/2` plug-in checks
 * `payload.action` against the route name (`heartbeat.submit`,
 * `ghost.summon`, `object.mint`, etc.).
 *
 * This union is the single source of truth: web/mobile clients MUST
 * source their local signed-action types from it so the compiler —
 * not an unsafe cast — rejects actions the backend does not know.
 */
export const SIGNED_WRITE_ACTIONS = [
  'heartbeat.submit',
  'ghost.summon',
  'object.mint',
  'agent.create',
  'agent.update',
  'agent.fund',
  'agent.withdraw',
  'agent.authorize',
  'agent.mine',
  'agent.transactions',
  'agent.conversation',
  'agent.runs',
  'agent.invoke',
  'agent.approach',
  'agent.invoke_agent',
  'agent.brain.read',
  'agent.brain.update',
  'agent.list',
  'agent.cancel_listing',
  'agent.buy',
  'agent.lock',
  'agent.unlock',
  // Agent World Action Layer (Milestone A): owner capability + action envelopes
  'agent.capabilities.read',
  'agent.capability.grant',
  'agent.capability.revoke',
  'agent.action.dry_run',
  'agent.action.execute',
  // Milestone C: owner audit feed envelope
  'agent.actions.read',
  // Milestone D: owner recurring-action schedule envelopes
  'agent.schedule.create',
  'agent.schedule.list',
  'agent.schedule.update',
  'agent.schedule.delete',
  // Pin-as-foundation ownership writes
  'pin.attach',
  'pin.detach',
  'pin.transfer_claim',
  // Map-trade v1: NFT pin listings
  'ordinal.list',
  'ordinal.cancel_listing',
  'ordinal.buy',
  'sponsorship.status',
  'sponsorship.record',
  'sponsorship.broadcast',
] as const;

export type SignedWriteAction = (typeof SIGNED_WRITE_ACTIONS)[number];

/** Runtime membership check for the closed signed-write action union. */
export function isSignedWriteAction(value: unknown): value is SignedWriteAction {
  return typeof value === 'string' && (SIGNED_WRITE_ACTIONS as readonly string[]).includes(value);
}

export interface SignedWriteEnvelope {
  /** Discriminator for the backend's signed-write pipeline. Always `signed_write`. */
  mode: 'signed_write';
  /** Uppercase HTTP method executed by the server. */
  method: 'POST' | 'PUT' | 'DELETE';
  /** Exact request path, including the resource identifier. */
  path: string;
  /** Action verb, e.g. `heartbeat.submit`. */
  action: SignedWriteAction;
  /** Action-specific body. The backend merges this with `payload` at verification time. */
  body: Record<string, unknown>;
  /** Unix timestamp (seconds). Backend rejects if outside ±300s window. */
  timestamp: number;
  /** Per-signature random value. Prevents identical same-second writes from colliding. */
  nonce: string;
  /** Required: mainnet | testnet. Missing is not treated as mainnet. */
  network: LocusNetwork;
  /** Required: API deployment host this envelope is intended for. */
  audience: string;
}

export interface SignedWriteRequest extends SignedWriteEnvelope {
  /** Wallet BSV signature over `canonicalSignedWriteMessage(envelope)`. */
  signature: string;
  /** Wallet identity public key (hex). */
  pubkey: string;
}

/**
 * Canonical JSON serialiser matching the server's
 * `WriteEnvelope.canonical_json/1` (sort keys, no whitespace, no
 * surrogate escaping). Both sides MUST emit byte-identical output —
 * a single whitespace difference breaks the signature verification.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compute the bytes the wallet must sign. This MUST equal the
 * server's `WriteEnvelope.canonical_message/1` output:
 *
 *     "Locus Signed Write\n" + canonical_json(payload)
 */
export function canonicalSignedWriteMessage(envelope: SignedWriteEnvelope): string {
  return SIGNED_WRITE_MESSAGE_PREFIX + canonicalJson(envelope);
}
```

### E4 — `locus-mobile/backend/locus_api/lib/locus_api_web/router.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 1–262:

```elixir
defmodule LocusApiWeb.Router do
  use LocusApiWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :authenticated_api do
    plug :accepts, ["json"]
    plug LocusApiWeb.Plugs.LoadCurrentUser
  end

  pipeline :signed_write_api do
    plug :accepts, ["json"]
    plug LocusApiWeb.Plugs.VerifySignedWrite
  end

  scope "/", LocusApiWeb do
    pipe_through :api

    get "/health", HealthController, :show
  end

  scope "/api/v1", LocusApiWeb do
    pipe_through :api

    get "/health", HealthController, :show
    post "/auth/challenge", AuthController, :challenge
    post "/auth/verify", AuthController, :verify
    post "/auth/refresh", AuthController, :refresh
    post "/auth/logout", AuthController, :logout

    get "/territory/at", TerritoryController, :by_location
    post "/territory/at", TerritoryController, :by_location
    get "/territory/:hex_id", TerritoryController, :show
    get "/cities", CityController, :index
    get "/cities/global", CityController, :index
    get "/cities/:id", CityController, :show
    get "/cities/:id/sprawl", CityController, :sprawl
    get "/cities/:id/treasury", CityController, :treasury
    get "/city/:city_id/treasury", CityController, :treasury

    get "/ghosts", GhostController, :nearby
    get "/ghosts/nearby", GhostController, :nearby
    post "/ghosts/nearby", GhostController, :nearby
    get "/ghosts/:id", GhostController, :show

    # BRC-169 Agent handle resolver: read-only identity preview for handles like @scout:gryd.world.
    get "/agent-handles/:handle", AgentHandleController, :show

    # Canonical Agent API: returns { agents: [...] } (starters + user-dropped AGENT objects).
    # The legacy /api/v1/agents alias to GhostController is replaced by AgentController.
    # /ghosts/* remains on GhostController for backwards compatibility.
    get "/agents", AgentController, :nearby
    get "/agents/nearby", AgentController, :nearby
    get "/agents/mine", AgentController, :mine
    get "/agents/:id/conversation", AgentController, :conversation
    post "/agents/:id/conversation", AgentController, :conversation
    get "/agents/:id/runs", AgentController, :runs
    post "/agents/:id/runs", AgentController, :runs
    # Phase A: brain summary (public; content is owner-gated) + model registry.
    get "/agents/models", AgentController, :models
    # Phase D marketplace — must precede /agents/:id (Phoenix matches in order).
    # Public reads here; the signed writes live in the :signed_write_api scope
    # below (the VerifySignedWrite plug must actually run on them — a 2026-08-07
    # live E2E caught these POSTs sitting in the public scope, where the plug
    # never ran and every signed market write 401'd).
    get "/agents/market", AgentMarketController, :market
    get "/agents/:id/listing", AgentMarketController, :listing
    # Map-trade v1: public NFT-listing reads (writes in the signed scope).
    get "/market/ordinals", AgentMarketController, :ordinals_market
    get "/market/ordinals/:outpoint/listing", AgentMarketController, :ordinal_listing

    # Admin ops failsafe (2026-08-08): force-cancel a listing whose covenant
    # bricked on-chain. Token-gated (LOCUS_ADMIN_TOKEN), NOT signed-envelope.
    post "/admin/market/listings/:id/cancel", AgentMarketController, :admin_cancel_listing
    get "/agents/:id/brain", AgentController, :brain
    get "/agents/:id/x402-info", AgentController, :x402_info
    get "/agents/:id", AgentController, :show

    # Public, unauthenticated invoke for the MVP LLM runtime.
    # Will move behind the signed-write pipeline once tools can spend or
    # mutate user-owned state.
    post "/agents/:id/invoke", AgentController, :invoke
    # Proximity trigger: the client fires this when a user walks within
    # the Agent's radius; the server re-validates distance + cooldown.
    post "/agents/:id/approach", AgentController, :approach

    # Phase 2 wallet writes/read-private surfaces live in the signed-write scope below
    # so owner identity is derived from the verified wallet signature, not request-body strings.

    # BRC-121 paid actions are disabled by default. The public route exists only
    # as a guarded contract seam until explicit production rollout.
    post "/paid-actions/agent-preview", PaidActionController, :agent_preview
    get "/paid-actions/receipts/:nonce", PaidActionController, :receipt
    get "/paid-actions/recovery/:nonce", PaidActionController, :action_recovery
    post "/paid-actions/recovery/:nonce/resume", PaidActionController, :resume_action

    get "/objects/placed", ObjectController, :placed
    post "/objects/placed", ObjectController, :placed
    get "/objects/:id", ObjectController, :show

    get "/stake/:id/status", StakeController, :status
  end

  scope "/api/v1", LocusApiWeb do
    pipe_through :authenticated_api

    get "/auth/me", AuthController, :me
    get "/profile", UserController, :profile
    get "/user/profile", UserController, :profile
    get "/user/balance", UserController, :balance

    get "/territory/staked", TerritoryController, :staked
    get "/territory/:hex_id/unlock-status", TerritoryController, :unlock_status

    get "/ghosts/dialogue", GhostController, :dialogue

    get "/objects/inventory", ObjectController, :inventory
    get "/objects/mine", ObjectController, :inventory

    get "/heartbeat/challenge", HeartbeatController, :challenge
    get "/heartbeat/status", HeartbeatController, :status
    get "/heartbeat/presence", HeartbeatController, :status
    get "/heartbeat/history", HeartbeatController, :history

    # Heartbeat submit needs both the JWT user (so we can look up the cached
    # challenge using the same public key it was issued to) and the signed-write
    # signature (so we know the write is authorized). Some wallets expose
    # distinct identity/signing keys, so the signed-write pubkey may differ
    # from the JWT user's public key. We verify the signature, but we use the
    # JWT user's public key for the challenge/proof lookup.
    pipe_through :signed_write_api

    post "/heartbeat/submit", HeartbeatController, :submit
    post "/heartbeat", HeartbeatController, :submit
  end

  scope "/api/v1", LocusApiWeb do
    pipe_through :signed_write_api

    post "/territory/claim", LegacyController, :gone
    post "/territory/stake", LegacyController, :gone
    post "/territory/release", LegacyController, :gone
    post "/territory/:hex_id/unstake", LegacyController, :gone

    post "/cities/found", LegacyController, :gone
    post "/cities/join", LegacyController, :gone
    post "/cities/leave", LegacyController, :gone
    post "/cities/claim-ubi", LegacyController, :gone
    post "/cities/redeem-tokens", LegacyController, :gone

    post "/ghosts/summon", GhostController, :summon
    post "/ghosts/invoke", GhostController, :summon
    post "/ghosts/:id/summon", GhostController, :summon

    post "/objects/mint", ObjectController, :mint
    post "/objects/:id/claim", ObjectController, :claim

    get "/sponsorship/status", SponsorshipController, :status
    post "/sponsorship/status", SponsorshipController, :status
    post "/sponsorship/record", SponsorshipController, :record
    post "/sponsorship/broadcast", SponsorshipController, :broadcast

    # Agent World Action Layer — all capability management and action execution
    # is owner-signed. Controllers also bind each exact signed action name to
    # its route before touching grants, quotas, requests, or audits.
    post "/agents/:id/capabilities/list", AgentCapabilityController, :index
    post "/agents/:id/capabilities", AgentCapabilityController, :create
    post "/agents/:id/capabilities/:grant_id/revoke", AgentCapabilityController, :revoke
    post "/agents/:id/actions/dry-run", AgentActionController, :dry_run
    post "/agents/:id/actions", AgentActionController, :execute
    post "/agents/:id/actions/list", AgentActionController, :index
    post "/agents/:id/schedules", AgentScheduleController, :create
    post "/agents/:id/schedules/list", AgentScheduleController, :index
    post "/agents/:id/schedules/:schedule_id", AgentScheduleController, :update
    post "/agents/:id/schedules/:schedule_id/delete", AgentScheduleController, :delete

    # Agent Builder / Wallet writes and private read surfaces require a signed-write envelope.
    # The controller derives owner identity from current_write_pubkey;
    # request-body owner_address is ignored for authorization.
    post "/agents/mine", AgentController, :mine
    post "/agents", AgentController, :create
    put "/agents/:id", AgentController, :update
    # Phase A: owner-gated brain write + full read for the Builder editor.
    put "/agents/:id/brain", AgentController, :put_brain
    post "/agents/:id/brain/full", AgentController, :brain_full
    post "/agents/:id/fund", AgentController, :fund
    post "/agents/:id/withdraw", AgentController, :withdraw
    post "/agents/:id/authorize", AgentController, :authorize

    # Phase D marketplace writes — signed (agent.list / agent.cancel_listing /
    # agent.buy / agent.lock / agent.unlock). The plug assigns
    # current_write_action/current_write_pubkey the controller enforces.
    post "/agents/:id/list", AgentMarketController, :list
    post "/agents/:id/listing/cancel", AgentMarketController, :cancel
    post "/agents/:id/listing/close", AgentMarketController, :close
    post "/agents/:id/lock", AgentMarketController, :lock
    post "/agents/:id/unlock", AgentMarketController, :unlock
    # Map-trade v1 NFT writes (ordinal.list / ordinal.cancel_listing /
    # ordinal.buy) — same signed-write plug, target = origin outpoint.
    post "/market/ordinals/list", AgentMarketController, :list_ordinal
    post "/market/ordinals/cancel", AgentMarketController, :cancel_ordinal
    post "/market/ordinals/close", AgentMarketController, :close_ordinal
    get "/agents/:id/transactions", AgentController, :transactions
    post "/agents/:id/transactions", AgentController, :transactions
    post "/agents/:id/to/:target_id/invoke", AgentController, :invoke_agent_to_agent

    post "/stake/draft", LegacyController, :gone
    post "/stake/submit", LegacyController, :gone
    post "/stake/claim", LegacyController, :gone
    post "/territory/stake/submit", LegacyController, :gone
    post "/territory/stake/claim", LegacyController, :gone
  end

  scope "/v2", LocusApiWeb do
    pipe_through :api

    get "/pins", PinController, :index
    post "/pins", PinController, :create
    delete "/pins/:txid", PinController, :evict
    get "/pins/by-prefix/*prefix", PinController, :by_prefix
    get "/pins/:txid/attachments", PinController, :attachments
    get "/pins/:txid", PinController, :show
    get "/cities", CityController, :v2_index
    get "/cities/nearby", CityController, :nearby
    get "/cities/by-prefix/*prefix", CityController, :show_by_prefix
    get "/cities/:prefix", CityController, :show_by_prefix
    get "/activity/global", PinController, :global_activity
    get "/reports", WorldReportController, :index
    get "/reports/:id", WorldReportController, :show

    # Milestone C: public, unsigned reads of Agent-authored annotations on
    # existing pins/objects. The annotated artifacts themselves stay chain-truth.
    get "/pins/:txid/annotations", WorldAnnotationController, :pin_annotations
    get "/objects/:id/annotations", WorldAnnotationController, :object_annotations
    get "/inscriptions/:identifier", InscriptionController, :show
  end

  # Pin ownership writes (attach/detach) — signed-write envelope required;
  # the controller enforces pin ownership against the signer's address.
  scope "/v2", LocusApiWeb do
    pipe_through :signed_write_api

    post "/pins/:txid/attachments", PinController, :attach
    delete "/pins/:txid/attachments/:id", PinController, :detach
    post "/pins/:txid/transfer_claim", PinController, :transfer_claim
  end

  scope "/api/v2", LocusApiWeb do
    pipe_through :api

    get "/inscriptions/:address", InscriptionsController, :index
  end

  scope "/v2", LocusApiWeb do
    pipe_through :signed_write_api

    post "/admin/run-city-emergence", CityController, :run_city_emergence
    post "/admin/refresh-city-stats", CityController, :refresh_city_stats
  end
end
```

### E5 — `locus-mobile/backend/locus_api/scripts/sponsored_broadcast.js`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 15–17:

```js
const WOC_ENDPOINT = process.env.WOC_ENDPOINT || 'https://api.whatsonchain.com/v1/bsv/main';
const DEFAULT_FEE_SATOSHIS = Number(process.env.LOCUS_SPONSOR_FEE_SATOSHIS || '500');
const DUST_SATOSHIS = 546;
```

Verbatim lines 63–87:

```js
function buildPayload(action, attrs, sponsorAddress) {
  const lat = numberValue(attrs.lat, undefined);
  const lng = numberValue(attrs.lng, undefined);
  const type = attrs.type || (action === 'mint' ? 'object' : 'presence');
  const now = Math.floor(Date.now() / 1000);
  return Object.fromEntries(Object.entries({
    p: 'locus',
    v: 3,
    op: action === 'mint' ? 'mint' : 'place',
    lat,
    lng,
    type,
    subtype: attrs.subtype,
    content_uri: attrs.contentUri || attrs.content_uri,
    owner: attrs.owner_address || attrs.ownerAddress || attrs.user_public_key,
    sponsor: sponsorAddress,
    sponsored: true,
    // Pin-as-foundation (2026-08-11): sponsored place txs mint a 1Sat ordinal
    // tip at vout 0 — flag the payload so the indexer records is_ordinal.
    is_ordinal: action === 'place' ? true : undefined,
    ts: now,
    metadata: attrs.metadata,
    proof: attrs.proof,
  }).filter(([, v]) => v !== undefined && v !== null));
}
```

Verbatim lines 95–140:

```js
async function getFundingUtxos(address) {
  const rows = await getJson(`${WOC_ENDPOINT}/address/${address}/unspent`);
  return rows.map(row => ({
    txid: row.tx_hash || row.txid,
    vout: row.tx_pos ?? row.vout,
    satoshis: Number(row.value || row.satoshis),
  })).filter(u => u.txid && Number.isInteger(u.vout) && Number.isSafeInteger(u.satoshis) && u.satoshis > 0)
    .sort((a, b) => b.satoshis - a.satoshis);
}

async function fetchSourceTx(txid) {
  const res = await fetch(`${WOC_ENDPOINT}/tx/${txid}/hex`, { headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`source tx ${txid} fetch failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const text = (await res.text()).trim();
  // WOC returns bare hex for this endpoint; tolerate a JSON wrapper too.
  const hex = text.startsWith('{') ? (JSON.parse(text).hex || '') : text;
  if (!hex) throw new Error(`source tx ${txid}: empty hex response`);
  return Transaction.fromHex(hex);
}

async function broadcast(rawtx) {
  // WoC's free tier 429s under bursty load — retry with backoff before
  // failing the caller (a withdraw/mint must not die on a transient hiccup).
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${WOC_ENDPOINT}/tx/raw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ txhex: rawtx }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`broadcast failed (${res.status}): ${text.slice(0, 300)}`);
      try {
        const json = JSON.parse(text);
        return String(json.txid || json.data || text.replace(/"/g, '')).trim();
      } catch (_) {
        return text.replace(/"/g, '').trim();
      }
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}
```

Verbatim lines 142–251:

```js
async function main() {
  const request = JSON.parse(await readStdin());
  const sponsorKey = PrivateKey.fromWif(request.sponsor_wif);
  const sponsorAddress = String(sponsorKey.toAddress());
  const p2pkh = new P2PKH();
  const action = request.action;
  const allowedActions = new Set(['place', 'mint', 'heartbeat', 'imported_nft', 'agent_payout']);
  if (!allowedActions.has(action)) throw new Error(`Unsupported sponsored action: ${action}`);
  const attrs = request.attrs || {};
  if (action === 'mint' && !(attrs.owner_address || attrs.ownerAddress)) {
    throw new Error('Sponsored mint requires an owner address');
  }

  // ── Agent withdrawal payout (custodial, chain-receipted) ─────────────
  // The Agent ledger is off-chain; deposits physically sit in this treasury.
  // A withdraw therefore pays the agent's REGISTERED OWNER on-chain from the
  // treasury, and carries an `agent_payout` OP_RETURN receipt so every
  // treasury outflow names its reason for audit. The Elixir side broadcasts
  // FIRST and only then debits the ledger, so failures favor the user.
  let payout = null;
  if (action === 'agent_payout') {
    let toAddress = String(attrs.to_address || '');
    // The ledger records owners as compressed pubkeys (owner_address fields
    // across the Agent system are pubkeys, not base58) — derive the wallet
    // address from the pubkey so the payout lands in the owner's wallet.
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(toAddress)) {
      toAddress = String(PublicKey.fromString(toAddress).toAddress());
    }
    const amountSats = Number(attrs.amount_sats);
    if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(toAddress)) {
      throw new Error('agent_payout requires a valid mainnet to_address (or owner pubkey)');
    }
    if (!Number.isSafeInteger(amountSats) || amountSats < 1) {
      throw new Error('agent_payout requires a positive integer amount_sats');
    }
    if (!attrs.agent_id) throw new Error('agent_payout requires an agent_id');
    payout = {
      toAddress,
      amountSats,
      receipt: {
        p: 'locus',
        v: 3,
        op: 'agent_payout',
        agent_id: String(attrs.agent_id),
        to: toAddress,
        amount: amountSats,
        ts: Math.floor(Date.now() / 1000),
      },
    };
  }

  const payload = payout ? payout.receipt : buildPayload(action, attrs, sponsorAddress);
  const feeTarget = Math.max(DEFAULT_FEE_SATOSHIS, Number(attrs.fee_satoshis || attrs.feeSatoshis || 0));
  // Pin-as-foundation model (2026-08-11): mint AND place/imported_nft txs pay
  // a 1-sat output to the owner at vout 0 — the pin's transferable ownership
  // tip. Before this, sponsored place txs had no owner output at all, which
  // made those pins untransferable.
  const paysOwner = action === 'mint' || action === 'place' || action === 'imported_nft';
  const fixedOutputs = paysOwner ? 1 : (payout ? payout.amountSats : 0);
  const required = feeTarget + fixedOutputs;
  const selected = [];
  let totalIn = 0;
  for (const utxo of await getFundingUtxos(sponsorAddress)) {
    selected.push(utxo);
    totalIn += utxo.satoshis;
    if (totalIn >= required + DUST_SATOSHIS) break;
  }
  if (totalIn < required) throw new Error(`Sponsor wallet has insufficient funds: need ${required}, have ${totalIn}`);

  const tx = new Transaction();
  const sponsorLock = p2pkh.lock(sponsorAddress);
  for (const utxo of selected) {
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      // @bsv/sdk's fee computation reads satoshis from the attached source
      // transaction, so fetch the full funding tx for every input.
      sourceTransaction: await fetchSourceTx(utxo.txid),
      unlockingScriptTemplate: p2pkh.unlock(sponsorKey, 'all', false, utxo.satoshis, sponsorLock),
      sequence: 0xffffffff,
    });
  }

  const ownerAddress = attrs.owner_address || attrs.ownerAddress || sponsorAddress;
  if (paysOwner) {
    tx.addOutput({ satoshis: 1, lockingScript: p2pkh.lock(ownerAddress) });
  }
  if (payout) {
    // Payout is vout 0 — deterministic for the ledger row's payout_vout.
    tx.addOutput({ satoshis: payout.amountSats, lockingScript: p2pkh.lock(payout.toAddress) });
  }
  tx.addOutput({ satoshis: 0, lockingScript: opReturnScript(payload) });
  tx.addOutput({ lockingScript: sponsorLock, change: true });
  await tx.fee(feeTarget);
  await tx.sign();
  const rawtx = tx.toHex();
  const txid = await broadcast(rawtx);

  // The Phoenix Port driver holds our stdin open, which would keep the event
  // loop alive forever — exit explicitly once the result has been flushed.
  process.stdout.write(JSON.stringify({
    success: true,
    txid,
    rawtx,
    fee_satoshis: tx.getFee(),
    provider: 'whatsonchain',
    sponsor_address: sponsorAddress,
    payload,
    ...(payout ? { payout_vout: 0, payout_sats: payout.amountSats, payout_address: payout.toAddress } : {}),
  }), () => process.exit(0));
```

### E6 — `locus-web/src/hooks/useLocusWallet.ts`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 1–10:

```ts
/**
 * useLocusWallet — bridge between the Locus UI and connected BRC-100
 * providers (via `@1sat/react` / `@1sat/actions` / `@1sat/client`) plus the
 * embedded Gryd Wallet.
 *
 * The legacy `yours-wallet-provider` package and the `window.yours` global
 * were removed in Yours Wallet 5.0. See
 * https://yours-wallet.gitbook.io/provider-api/migration/legacy-provider
 *
 * The hook preserves the legacy operational methods while attaching explicit
```

Verbatim lines 758–778:

```ts
  const signMessage = useCallback(
    async (msg: string): Promise<{ address: string; pubKey: string; sig: string; message: string } | null> => {
      // Embedded Gryd wallet: sign locally with the root key (classic BSM).
      // This is what makes backend auth + sponsored actions work without
      // a browser-extension wallet — previously this returned null via the
      // ctx gate and every auth attempt collapsed to 'sign-declined'.
      if (grydConnected) {
        return gryd.signMessage ? gryd.signMessage(msg) : null;
      }
      if (!ctx) return null;
      const result = await signBsm.execute(ctx, { message: msg });
      if (result.error || !result.sig || !result.address || !result.pubKey) return null;
      return {
        address: result.address,
        pubKey: result.pubKey,
        sig: result.sig,
        message: result.message ?? msg,
      };
    },
    [ctx, grydConnected, gryd],
  );
```

### E7 — `locus-mobile/backend/locus_api/lib/locus_api_web/controllers/pin_controller.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 279–293:

```elixir
  def transfer_claim(conn, params) do
    claimant = signer_address(conn)
    txid = conn.path_params["txid"]

    with :ok <- ensure_action(conn, "pin.transfer_claim"),
         {:ok, pin} <- pin_for_write(txid),
         {:ok, new_tip} <-
           LocusApi.World.PinTransfer.verify(pin, params["transfer_txid"], claimant),
         {:ok, %{pin: pin, released_attachments: released}} <-
           World.apply_pin_transfer(pin, claimant, new_tip) do
      json(conn, %{
        success: true,
        pin: World.serialize_pin(pin),
        released_attachments: released
      })
```

Verbatim lines 361–379:

```elixir
  defp signer_address(conn) do
    conn.assigns[:current_write_pubkey]
    |> LocusApi.AgentMarketplace.CompletionVerifier.identity_address()
  end

  defp require_pin_owner(conn, pin) do
    if signer_address(conn) == pin.owner_address do
      :ok
    else
      {:error, :not_owner}
    end
  end

  defp ensure_action(conn, expected_action) do
    case conn.assigns[:current_write_action] do
      ^expected_action -> :ok
      _ -> {:error, :unexpected_action}
    end
  end
```

### E8 — `locus-mobile/backend/locus_api/lib/locus_api_web/controllers/sponsorship_controller.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 6–32:

```elixir
  @broadcast_actions ["sponsorship.broadcast"]
  @record_actions ["sponsorship.record"]

  def status(conn, _params) do
    user_public_key = conn.assigns.current_write_pubkey
    json(conn, %{sponsorship: Sponsorships.status(user_public_key)})
  end

  def broadcast(conn, params) do
    user_public_key = conn.assigns.current_write_pubkey
    params = write_params(conn, params)

    with :ok <- ensure_action(conn, @broadcast_actions),
         {:ok, action} <- required_string(params, "action"),
         :ok <- ensure_sponsored_action(action),
         {:ok, sponsored_action} <-
           Sponsorships.broadcast_and_account(user_public_key, action, params) do
      conn
      |> put_status(:created)
      |> json(%{
        success: true,
        txid: sponsored_action.txid,
        rawtx: sponsored_action.metadata["rawtx"],
        payload: sponsored_action.metadata["payload"],
        sponsorship: Sponsorships.status(user_public_key),
        sponsored_action: serialize(sponsored_action)
      })
```

Verbatim lines 52–66:

```elixir
      {:error, :sponsorship_pending} ->
        conn
        |> put_status(:conflict)
        |> json(%{
          error: "A sponsored action is already pending; do not submit a new transaction",
          sponsorship: Sponsorships.status(user_public_key)
        })

      {:error, :broadcast_uncertain} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{
          error: "Sponsored broadcast outcome is uncertain; do not retry a new transaction",
          sponsorship: Sponsorships.status(user_public_key)
        })
```

### E9 — `locus-mobile/backend/locus_api/lib/locus_api/sponsored_action.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 1–25:

```elixir
defmodule LocusApi.SponsoredAction do
  use Ecto.Schema
  import Ecto.Changeset

  @timestamps_opts [type: :utc_datetime]
  @allowed_actions ["place", "mint", "heartbeat", "imported_nft"]

  schema "sponsored_actions" do
    field :user_public_key, :string
    field :action, :string
    field :txid, :string
    field :fee_satoshis, :integer, default: 0
    field :metadata, :map, default: %{}

    timestamps()
  end

  def allowed_actions, do: @allowed_actions

  def changeset(action, attrs) do
    action
    |> cast(attrs, [:user_public_key, :action, :txid, :fee_satoshis, :metadata])
    |> validate_required([:user_public_key, :action, :fee_satoshis])
    |> validate_length(:user_public_key, min: 8)
    |> validate_inclusion(:action, @allowed_actions)
```

### E10 — `locus-mobile/backend/locus_api/lib/locus_api/sponsored_broadcast.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 28–45:

```elixir
  def broadcast(action, attrs) do
    with {:ok, wif} <- sponsor_wif(),
         {:ok, payload} <- Jason.encode(%{action: action, attrs: attrs, sponsor_wif: wif}),
         {:ok, output} <- run_node(payload),
         {:ok, decoded} <- Jason.decode(output) do
      case decoded do
        %{"success" => true} = result -> {:ok, result}
        %{"error" => error} -> {:error, error}
        _ -> {:error, "Sponsored broadcaster returned an invalid response"}
      end
    end
  end

  defp sponsor_wif do
    case System.get_env("LOCUS_SPONSOR_WIF") || System.get_env("GRYD_SPONSOR_WIF") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :sponsor_wallet_not_configured}
    end
```

### E11 — `locus-mobile/backend/locus_api/lib/locus_api/bsv/one_sat.ex`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 108–122:

```elixir
    nfts =
      raw_nfts
      |> Enum.reverse()
      |> Enum.map(&normalize_txo/1)
      # Ownership is an outpoint property. Two currently held editions can
      # share one origin, so dedupe by the held outpoint rather than origin.
      |> Enum.uniq_by(&"#{&1.kind}:#{&1.outpoint}")

    cond do
      stream_error -> {:error, stream_error}
      not completed -> {:error, :incomplete_stream}
      is_integer(expected_total) and expected_total > length(raw_nfts) -> {:partial, nfts}
      length(raw_nfts) >= limit -> {:partial, nfts}
      true -> {:ok, nfts}
    end
```

Verbatim lines 153–158:

```elixir
  defp owner_url(address, limit) do
    base = base_url()

    "/1sat/owner/#{address}/txos?unspent=true&limit=#{limit}"
    |> then(&build_full_url(base, &1))
  end
```

Verbatim lines 249–257:

```elixir
  defp base_url do
    Application.get_env(:locus_api, __MODULE__, [])
    |> Keyword.get(:indexer_endpoint, "https://api.1sat.app")
  end

  defp content_cdn do
    Application.get_env(:locus_api, __MODULE__, [])
    |> Keyword.get(:content_cdn, "https://api.1sat.app/content")
  end
```

### E12 — `locus-web/src/utils/nftPreview.ts`

Commit: `e6763c71f75a12acf8df3529e4ccc3fd50b16d80` (the-grid).

Verbatim lines 47–48:

```ts
export const NFT_MAINNET_CDN = 'https://api.1sat.app/content';
export const NFT_TESTNET_CDN = 'https://testnet.api.1sat.app/content';
```

### D1 — `src/gryd-attest.ts`

Commit: `d56862df78cf0bc0ad9ec464b91c1c8fa5df496b` (Dogfood).

Verbatim lines 12–21:

```ts
export const ATTESTATION_PREFIX = 'Dogfood Attestation v1\n';
export const MAX_OBSERVATION_BYTES = 32768;
const MAX_RESPONSE_BYTES = 2097152;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export interface Observation {
  type: string; lat: number; lng: number; observedAt: string;
  source: {kind:'api'|'sensor'|'human'; ref:string};
  payload: Record<string,unknown>;
  agent: {id:string; ownerAddress:string};
}
```

Verbatim lines 62–78:

```ts
export function validateObservation(value:unknown):Observation {
  safeJson(value);
  exact(value,['type','lat','lng','observedAt','source','payload','agent']);
  if(!text(value.type,96)||! /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value.type))invalid('type namespace');
  if(typeof value.lat!=='number'||!Number.isFinite(value.lat)||Math.abs(value.lat)>90||typeof value.lng!=='number'||!Number.isFinite(value.lng)||Math.abs(value.lng)>180)invalid('lat/lng');
  if(typeof value.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt)invalid('UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ');
  exact(value.source,['kind','ref']);
  if(!['api','sensor','human'].includes(value.source.kind as string)||!text(value.source.ref,1024))invalid('source');
  exact(value.agent,['id','ownerAddress']);
  if(!text(value.agent.id,200)||!text(value.agent.ownerAddress,35))invalid('agent');
  try {new P2PKH().lock(value.agent.ownerAddress);}catch{invalid('ownerAddress');}
  // Mainnet P2PKH only; SDK lock also accepts other base58 versions.
  const decoded=Utils.fromBase58Check(value.agent.ownerAddress);
  if(decoded.prefix.length!==1||decoded.prefix[0]!==0||decoded.data.length!==20)invalid('mainnet ownerAddress');
  if(!object(value.payload))invalid('payload object');
  const json=canonicalJson(value);if(Buffer.byteLength(json)>MAX_OBSERVATION_BYTES)invalid('observation size');
  return JSON.parse(json) as Observation;
```

### D2 — `src/gryd-attest.ts`

Commit: `d56862df78cf0bc0ad9ec464b91c1c8fa5df496b` (Dogfood).

Verbatim lines 80–100:

```ts
export function canonicalAttestationMessage(value:unknown):string {return ATTESTATION_PREFIX+canonicalJson(validateObservation(value));}
export function signObservation(value:unknown,key:PrivateKey):Attestation {
  const observation=validateObservation(value);
  if(observation.agent.ownerAddress!==key.toAddress())invalid('ownerAddress must be the signing property address');
  return {observation,pubkey:key.toPublicKey().toString(),signature:BSM.sign(Utils.toArray(canonicalAttestationMessage(observation),'utf8'),key,'base64') as string};
}
export function verifyAttestation(value:unknown):Observation {
  safeJson(value,true);exact(value,['observation','pubkey','signature']);
  const observation=validateObservation(value.observation);
  if(typeof value.pubkey!=='string'||!/^(02|03)[a-f0-9]{64}$/.test(value.pubkey)||typeof value.signature!=='string'||!/^[A-Za-z0-9+/]{87}=$/.test(value.signature))invalid('public key/signature encoding');
  const pubkey=PublicKey.fromString(value.pubkey);
  const bytes=Buffer.from(value.signature,'base64');
  if(bytes.length!==65||bytes.toString('base64')!==value.signature||bytes[0]!<31||bytes[0]!>34)invalid('compact compressed BSM');
  if(pubkey.toAddress()!==observation.agent.ownerAddress)invalid('signer ownerAddress binding');
  const message=Utils.toArray(canonicalAttestationMessage(observation),'utf8');
  const signature=Signature.fromCompact(value.signature,'base64');
  if(!BSM.verify(message,signature,pubkey))invalid('signature');
  // SDK BSM.verify checks r/s only, not the compact recovery header.
  if(!signature.RecoverPublicKey(bytes[0]!-31,new BigNumber(BSM.magicHash(message))).eq(pubkey))invalid('signature recovery header');
  return observation;
}
```

Verbatim lines 118–130:

```ts
export async function verifyAttestationTx(txid:string,fetchFn:typeof fetch=globalThis.fetch.bind(globalThis)) {
  if(typeof txid!=='string'||!/^[a-f0-9]{64}$/.test(txid))invalid('txid lowercase 64 hex');
  const tx=await sourceTransaction(txid,boundedFetch(fetchFn)),output=tx.outputs[0];
  if(!output||output.satoshis!==1)invalid('output zero must be one satoshi');
  const script=output.lockingScript;
  if(script.toBinary().length>MAX_OBSERVATION_BYTES+1024||script.chunks.length!==13||!script.chunks[6]?.data)invalid('unsupported inscription script');
  const data=Buffer.from(script.chunks[6].data),json=data.toString('utf8');if(!data.equals(Buffer.from(json)))invalid('inscription UTF-8');
  const signed:unknown=JSON.parse(json),observation=verifyAttestation(signed),propertyAddress=observation.agent.ownerAddress;
  const s=signed as Attestation;
  // Exact format: JSON.stringify of the ordered wrapper, canonicalized observation.
  const expected=JSON.stringify({observation,pubkey:s.pubkey,signature:s.signature});
  if(json!==expected||script.toHex()!==inscriptionScript(propertyAddress,'application/json',expected).toHex())invalid('exact inscription/property locking address');
  return {authentic:true as const,txid,outpoint:txid+'_0',observation,propertyAddress,pubkey:s.pubkey,truthVerified:false as const,unspentChecked:false as const,confirmationChecked:false as const};
```

### D3 — `src/gryd-agent.ts`

Commit: `d56862df78cf0bc0ad9ec464b91c1c8fa5df496b` (Dogfood).

Verbatim lines 5–39:

```ts
// Agent subset of locus-protocol/src/signed-write.ts; see frozen vectors and
// scripts/gryd-agent-vectors.ts. No runtime dependency on the sibling repository.
export const AGENT_WRITE_ACTIONS = [
  "agent.create", "agent.update", "agent.fund", "agent.withdraw", "agent.authorize",
  "agent.mine", "agent.transactions", "agent.conversation", "agent.runs",
  "agent.invoke", "agent.approach", "agent.invoke_agent", "agent.brain.read", "agent.brain.update",
  "agent.list", "agent.cancel_listing", "agent.buy", "agent.lock", "agent.unlock",
  "agent.capabilities.read", "agent.capability.grant", "agent.capability.revoke",
  "agent.action.dry_run", "agent.action.execute", "agent.actions.read",
  "agent.schedule.create", "agent.schedule.list", "agent.schedule.update", "agent.schedule.delete",
] as const;
export type SignedWriteAction = (typeof AGENT_WRITE_ACTIONS)[number];
export interface SignedWriteEnvelope<A extends SignedWriteAction | "object.mint" = SignedWriteAction> {
  mode: "signed_write";
  method: "POST" | "PUT" | "DELETE";
  path: string;
  action: A;
  body: Record<string, unknown>;
  timestamp: number;
  nonce: string;
  /** Required by the deployed backend since the split-identity release — missing is NOT mainnet. */
  network: "mainnet" | "testnet";
  /** Required: API deployment host this envelope is intended for (prod = the-grid-api.fly.dev). */
  audience: string;
}
export interface SignedAgentRequest<A extends SignedWriteAction | "object.mint" = SignedWriteAction> {
  payload: SignedWriteEnvelope<A>;
  signature: string;
  pubkey: string;
  address: string;
}
type RequestBinding = Pick<SignedWriteEnvelope, "method" | "path">;
type EnvelopeOptions = Partial<Pick<SignedWriteEnvelope, "timestamp" | "nonce" | "network" | "audience">>;
/** The vault is mainnet-only and talks to the prod Gryd API; both are bound into every signature. */
export const GRYD_ENVELOPE_SCOPE = { network: "mainnet", audience: "the-grid-api.fly.dev" } as const;
```
