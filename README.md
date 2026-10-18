# Dogfood Wallet

The zero-trust wallet for agentic commerce. The LLM requests payment; a signer on **your** machine authorizes it. The model never sees the key.

One vault secret speaks three chains — BSV, USDC on Base, USDC on Solana — and pays HTTP 402 challenges in seconds for a fraction of a cent. A merchant server is included, so the same codebase that buys is the codebase that sells.

Open source (MIT). Not a hosted wallet. Not a consumer portfolio app. No revenue machinery, ever — if you charge with it, that money is yours.

**Live demo register:** [`dogfood-merchant.fly.dev/v1/fortune`](https://dogfood-merchant.fly.dev/v1/fortune) — call it with no credentials, get a 402 price menu.

**Receipts (every claim is auditable):**

- BSV mainnet — [500-sat 402 payment, ~$0.00004 fee](https://whatsonchain.com/tx/5e0dacad4106833a3e1cc78778dd77e1951b3c410d79080c438a031c5298119c)
- USDC on Base mainnet — [$0.001 settled by the wallet's own facilitator](https://basescan.org/tx/0xb5f3cb4356f37474dd5e3e80585c39d23958e1c03e706732b4eee8d76e9c43de)
- USDC on Solana devnet — [fee-payer co-signed, payer needs no SOL](https://solscan.io/tx/25Ung41rJSNDtNVFuLLrsmZDnd3Lqf53vmENniQ3Eavf4PSCkWnJSRovP1Twy6ZGDpn6tLbX4YPCxVp9v7wACQpd?cluster=devnet)

## Architecture

1. **Brain (agent)** — knows what to buy. Talks to the vault over MCP or CLI.
2. **Vault (this repo)** — keys, per-asset caps, allowlists, killfile, structured rejects. One 32-byte secret derives all three identities (BSV P2PKH, secp256k1 EVM, ed25519 Solana).
3. **Settlement** — whatever rail the merchant offers: BSV direct, or USDC via x402 `exact` on Base / Solana. Tiny fees make per-call payments real.

There is no `refund` tool. Sweep/recovery is the owner's job, not the agent's.

## Install

**New here? Start with the [BSV-first quickstart](docs/quickstart.md): isolated vault selection, deny-by-default policy, agent connection and offline recovery diagnostics. No funding or payment is needed for the rehearsal.**

Needs [Bun](https://bun.sh) **>=1.3.9** (tested baseline: 1.3.9). This is a
TypeScript/Bun CLI, not a Node executable. The package/bin name is `dogfood-wallet`;
no registry publication is claimed. See [local tarball installation and package
verification](docs/package-install.md) for the supported non-global package path.

```bash
git clone https://github.com/futureman19/dogfood-wallet
cd dogfood-wallet
bun install --frozen-lockfile
# Next: follow the quickstart to select an isolated vault before init/doctor.
```

The default vault is `~/.dogfood-wallet`; override with an absolute `DOGFOOD_WALLET_DIR` to avoid selecting the wrong vault. New vaults: **10,000 sats/tx**, **50,000 sats/day**, **empty allowlist** (a human must `allow` a BSV destination before the agent can send). EVM and Solana are optional tracks, not prerequisites. Never fund a disposable rehearsal vault.

```bash
bun src/cli.ts address                 # BSV
bun src/cli.ts evm-address             # Base/EVM
bun src/cli.ts sol-address             # Solana
bun src/cli.ts balance                 # plus evm-balance / sol-balance
bun src/cli.ts status
bun src/cli.ts doctor                 # offline metadata, no key decryption
bun src/cli.ts allow <address>         # BSV P2PKH only; human-only
bun src/cli.ts send <p2pkh-address> <sats> [--max-fee <sats>] [--] [note]
bun src/cli.ts fund-request <sats>
# or paste that address into the Yours button on https://dogfoodwallet.com
bun src/cli.ts kill                    # writes STOP_SPENDING
bun src/cli.ts sweep <p2pkh-address>
bun src/cli.ts split [piece-sats]
```

`allow`, `sweep`, `split`, and `fund-request` are **human-only** — not MCP tools. Sweep bypasses caps, allowlist, and killfile so the owner can take funds back. Split turns one fat UTXO into up to 20 even self-outputs so later agent sends are not serialized on a single coin. Split does **not** count against daily/lifetime caps. A **human** deletes `STOP_SPENDING` to resume agent sends. Agents must not.

## Gryd agent envelopes (Phase 1: offline, human-supervised)

```bash
# Select an existing, disposable UNFUNDED vault explicitly for rehearsal.
DOGFOOD_WALLET_DIR=/absolute/path/to/disposable-vault \
  bun src/cli.ts agent-call agent.mine POST /api/v1/agents/mine '{}'
```

`agent-call <agent.action> <POST|PUT|DELETE> <exact-path> '<body-json>'`
prints `{ payload, signature, pubkey, address }` JSON. It does **not** call Gryd,
broadcast a transaction, move funds, install permissions, or expose an MCP tool.
Human-supervised means an owner invokes this CLI deliberately; there is no
interactive confirmation or autonomous authorization policy in Phase 1.

Any `agent.*` action in the mirrored protocol `SignedWriteAction` union is
supported with an arbitrary JSON object body. Unknown/non-agent actions are
rejected. Supply the exact encoded route path and uppercase method: these are
signed, never normalized. Bodies must be plain JSON (no undefined, non-finite
numbers, custom objects or cycles). A fresh UUID and Unix-seconds timestamp are
generated per call; the network field is omitted as in the web client.

The signature is compact base64 Bitcoin Signed Message using the vault identity
key, over `Locus Signed Write\n` plus recursively key-sorted JSON. Keys never
appear in output. `STOP_SPENDING` blocks vault signing; local payment caps and
BRC-181 spend accounting are **not** an authorization policy for Gryd actions.
Treat printed envelopes as sensitive, usable authorizations: manually submitting
one later could authorize remote mutations, including financial actions. Do not
submit one as part of this offline rehearsal. The backend checks freshness (the
protocol specifies a 300-second skew window), ownership and route/action rules;
this slice does not prove live backend acceptance or autonomous transactions.

Library: `src/gryd-agent.ts` exports `signAgentRequest(action, body, { method,
path }, key, options?)` for explicit keys, and `signVaultAgentRequest(root,
action, body, { method, path })` for the guarded vault boundary. The pure-key
helper does not inspect a vault or its killfile. Timestamp/nonce/network options
on the pure helper support deterministic testing; the CLI offers no overrides.

Frozen canonicalization vectors were executed from
`packages/locus-protocol/src/signed-write.ts` in Gryd checkout
`211194c3ab177cefb2b359e27a5ceeaad4c012bf`; the fixture records its source SHA-256.
They cover nested key sorting (including numeric-looking keys), arrays, Unicode,
escaping, numeric formatting, encoded paths, all three methods, and optional
network. Signatures use public synthetic scalar 1, **not a vault key**.
Regenerate deliberately with `bun scripts/gryd-agent-vectors.ts <grid-repo-root>`;
review source hash/action-list changes rather than blindly accepting drift.
Neither tests nor the packaged CLI require a Gryd checkout.

## Gryd purchases (Phase 2: human-only)

```bash
# Inspect with an explicitly selected disposable vault; do not fund rehearsal vaults.
DOGFOOD_WALLET_DIR=/absolute/path/to/disposable-vault \
  bun src/cli.ts agent-buy <listing-txid>_0 <max-price-sats> --no-broadcast
```

**Without `--no-broadcast`, this command spends money.** It is owner-operated,
not an MCP tool, and only supports `agent.buy` (no list, cancel or lock).
The max is a positive decimal integer cap on the **embedded listing price**, not
the total debit. The buyer additionally pays `ceil(price / 40)` (2.5%) to Gryd
Fund `18Jc1Rq5Aw54UpCNLNvwoTLN4Uv5reTjCa` and a miner fee estimated at 1 sat/byte.
Preview displays these separately, with every input/output amount, destination
and role. Preview does chain/index GETs and validates policy, but never signs,
prints raw spendable bytes, broadcasts, emits a close envelope or records a spend.
It uses the shared payment lock temporarily and refuses existing holds.

The listing must be a canonical **legacy OrdLock**, worth exactly one satoshi.
WoC raw bytes must hash to the requested txid; the selected vout and satoshi value
must match the script-hash unspent triple. Price and seller **payAddress** are
parsed from the covenant's serialized payout, never from backend numbers or the
separate cancellation key. Extended/wrapped scripts, OrdLockV2, non-P2PKH payouts,
unknown/missing/spent listings and unavailable chain reads fail closed. The
unspent result is indexer evidence, not independent SPV or a guarantee against a
concurrent seller cancellation. Funding prevouts receive the same txid/vout/value
checks plus exact payment-address P2PKH matching; one-sat coins are excluded.

**Default: both seller and Fund must be allowed.** Without a `gryd` block,
local `policy.json` uses their base58 addresses (owner `allow` command) and the
existing local per-transaction/day/lifetime caps. An installed BRC-181 envelope
must permit both `p2pkh:<hash160>` destinations. Gates see **price + marketplace
fee** as the aggregate payout; BRC-181 also sees actual miner fees and cumulative
BSV usage. Per-destination envelope caps conservatively apply to the entire
payout, not just that destination's share. Existing BRC-181 evaluator limitations
(e.g. expiry/rate-window fields are not enforced) remain unchanged. A successful
buy logs the aggregate amount once, with miner fee separate; failed/ambiguous
broadcasts retain the shared durable payment hold and never auto-retry.

### Optional scoped Gryd purchase budget

An owner may add this block to the selected vault's `policy.json` (example limits,
not a recommendation or an installed policy):

```json
"gryd": { "maxPerTxSats": 5000, "maxPerDaySats": 20000 }
```

A valid block enables a **buyAgent-only** local policy scope: neither the
covenant-verified seller payout nor the hardcoded Gryd Fund destination needs a
local address allowlist entry. Instead, `maxPerTxSats` bounds **price + marketplace
fee**, and `maxPerDaySats` bounds the same amount plus the current UTC day's sum
of `amount` in `spends.jsonl` rows whose `kind` is `agent-buy`. Earlier purchases
count even if made before enabling the block. Other spend kinds and other UTC
days do not count toward this scoped day budget. Miner fees remain separate from
these two limits; installed BRC-181 fee and total-budget checks still include
them. Zero is valid and denies purchases; both fields must be nonnegative safe
integer numbers. Missing fields, null, strings, arrays, fractions, negatives and
unsafe values fail closed, never fall back to legacy permission.

This scoped budget replaces the ordinary local address/per-tx/day/lifetime gate
**only for Gryd purchases**. Ordinary sends and all other rails retain their
existing gates. Successful purchase rows still count in ordinary BSV usage for
subsequent operations. The killfile always overrides the budget. **An installed
BRC-181 envelope is never widened:** both seller and Fund must still satisfy its
destination rules, caps, miner-fee ceiling and cumulative budget. The CLI human
max-price cap, exact covenant checks, ordinal isolation and shared payment hold
also remain mandatory. No MCP tool or automatic policy editor is added.

Rationale: per-address allowlists do not fit an open marketplace where every
seller has a different address. The containment is the **covenant-verified atomic
swap**: the transaction pays the exact embedded seller payout while transferring
the ordinal to the buyer's isolated property identity. This is a scoped exemption
for that checked transaction shape, not permission to send arbitrary payments.
It does not establish an item's value or authenticity beyond existing chain and
listing checks; the budget bounds exposure, not investment quality.

Run `policy-inspect` with **no argument** to print the selected vault's normalized
local policy, including `gryd` when present and killfile state. It is read-only,
validates the block and never decrypts keys. The existing
`policy-inspect <envelope-json-or-file>` retains its BRC-181 verification behavior.
Stop operators before editing policy; this change does not install a block in any
vault or grant an agent access to a CLI it did not already have.

**Ordinal isolation:** output 0 goes to a dedicated property address derived by
`vault.key.deriveChild(vault.key.toPublicKey(), "dogfood/gryd/property/v1")`.
Only the root payment address is queried for coin selection, including existing
send/split/sweep flows; the property address is never in that pool. Keep this
fixed derivation with your vault backup. Do not manually send property back to
the payment address or import the property key as a payment vault. No property
sweep/export/transfer command is added in this phase.

The close-out envelope is signed by that **derived property identity**, not the
root payment identity: Gryd's verifier requires ordinal output 0 to match the
signed buyer. Gryd therefore records the derived identity as owner. The command
finds a unique matching open agent sale in the public marketplace index (first
200 results; missing/ambiguous entries fail closed), using it only for the agent
ID/route, not economic amounts. On broadcast acknowledgement it prints an
`agent.buy` envelope with `{ close_txid }` for
`POST /api/v1/agents/<encoded-agent-id>/listing/close`. It **never POSTs** this
request. Its normal short signature freshness window applies. ARC acknowledgement
is not mining confirmation or backend close-out success; review and submit the
close-out separately. Do not use Phase 1's root-key CLI to regenerate this derived
identity envelope. A later recovery tool must explicitly use the property key.

Construction decision: use **@bsv/sdk**, matching the web's pinned
`@1sat/actions@0.0.197` / `@1sat/templates@0.0.30` legacy purchase algorithm and
`@1sat/types@0.0.39` covenant bytes (MIT). No new dependencies. The actions flow
requires BRC-100 create/sign action services, metadata/basket resolution and wallet
tracking; adapting that lifecycle would obscure Dogfood's pre-sign gates, durable
holds and unsigned preview. This is not a claim that actions cannot run in Bun.
Input 0 is the listing; output 0 is the buyer ordinal, output 1 the exact seller
payout, output 2 the Fund fee, output 3 payment change. Funding signatures bind all
outputs. Every completed input is locally validated with SDK `Spend` before
broadcast. `defaultBroadcast` uses ARC, retaining its existing WoC fallback only
for explicit fee-policy rejections. Neither path is exercised against live funds
by the test suite.

The frozen real-chain fixture `testdata/gryd-buy-mainnet.json` contains purchase
`3f6eb7708619f08ced495e790b9bb343043f5d2f75a56a9098636579c8bd70c1`,
listing `363d0007faeb6424bdd2316af5487da80b45a4176e7f73419f1fb396bf2e42f8`,
buyer funding and inscription origin bytes fetched read-only from WoC. This is a
confirmed **Gryd QA sale**, not an organic-customer claim. The origin inscription
says `Gryd Market close-E2E fixture (burnable)`; Gryd's committed QA scripts link
that listing/purchase pair to the agent market. Historical sold API rows are not
publicly retrievable. Tests recompute all txids, reproduce the purchase unlock
byte-for-byte, validate both real input scripts, and check seller, Fund, ordinal
lineage and miner-fee arithmetic. Synthetic unfunded fixtures separately exercise
policy refusals and intercepted CLI/broadcast paths. No new live buy was made.

Before broadcast, private local `gryd-purchases/<txid>.json` recovery evidence
stores signed transaction bytes, input/output details, property public key and
payment ID (no private keys). Treat those bytes as spendable authorization. A
crash or timeout keeps the hold; inspect evidence and chain state manually, never
rerun the purchase blindly. File fsync is used; Windows directory-fsync/power-loss
limitations from the shared payment guard still apply. Do not edit policy or run
unguarded spenders concurrently. Live-fire and backend acceptance are separate
human-supervised review gates.

## Gryd listing and cancellation (Phase 3: human-only, backend pending)

```bash
# Use only a disposable unfunded vault for rehearsals.
bun src/cli.ts agent-list <ordinal-outpoint> <price-sats> --no-broadcast
bun src/cli.ts agent-cancel-listing <listing-outpoint> --no-broadcast
```

**Without `--no-broadcast`, both commands sign and broadcast on mainnet.**
They are deliberately owner CLI operations, not MCP tools. Do not use them live
until backend compatibility is fixed and separately verified. This is a wallet
implementation, **not a working end-to-end Gryd listing integration**.

**Known backend blocker:** Gryd's `listing_verifier.ex` currently constructs its
expected covenant with the same seller hash for cancellation and payout (lines
142–147); `completion_verifier.ex` also checks the seller payout. This wallet
intentionally uses the **property identity for cancellation and the MAIN vault
address for proceeds**. Those are different hashes. The existing backend cannot
accept this requested shape until its verification contract is updated. No Gryd
code is changed here. Results explicitly carry `backendCompatible: false`; this
is not dynamically negotiated. A successful ARC acknowledgement is neither
backend acceptance nor mining confirmation. The cancellation envelope does not
contain a cancellation txid because the exact current web API body is `{}`.

Listing requires a one-sat output owned by `dogfood/gryd/property/v1`: either
exact P2PKH or the exact Phase 4 Dogfood JSON ord envelope followed by that P2PKH.
Source bytes must hash to the requested txid; vout, value, script and script-hash
unspent evidence must agree. Arbitrary inscription wrappers, alternate JSON,
extra opcodes and other scripts are not accepted. Input 0 is property-key signed; output 0 is
one sat in the byte-exact pinned legacy OrdLock, with property cancellation hash
and requested positive safe-integer price payable to the main vault P2PKH.
Cancellation accepts only that exact covenant with both self-controlled hashes,
signs its cancellation branch with the property key, and returns output 0 to the
property address. Every signed input is validated locally using SDK `Spend`.

Only main-address coins greater than one sat fund fees, smallest-first. Their
raw source transactions, values and scripts are verified, with fresh unspent
triples immediately before signing. Change returns to main. `STOP_SPENDING`
refuses both operations. These self-controlled owner operations do not use local
allowlists, BRC-181 destination gates or `gryd` purchase budgets; only miner fees
leave the wallet. Successful accounting records `amount: 0` and the actual fee,
so no purchase amount budget is consumed. Other rails retain their own gates.

**Route identity is metadata, never spending authority.** The public marketplace
index only exposes open listings, while `/agents/mine` requires a signed POST.
To avoid inventing a public inventory endpoint, Phase 3 resolves output-zero
holdings from existing private `gryd-purchases/<txid>.json` evidence, or prior
Phase 3 cancellation/listing evidence under `gryd-listings/`, or verified Phase 4
registration evidence under `gryd-registrations/`. It checks the stored
transaction hash and unique agent ID, then confirms that ID using read-only
`GET /api/v1/agents/<encoded-id>`. Prices and ownership never come from this
metadata. Imported holdings, missing/corrupt/ambiguous evidence, nonzero vouts
without route provenance, or unavailable agent profiles fail closed. Back up
this evidence along with the vault; there is no guessed route or automatic
lineage scan. Thus a plain property UTXO without Dogfood provenance is not yet a
supported listing input even if it is cryptographically owned.

Preview holds the shared exclusive payment lock temporarily but does not reserve,
sign, emit spendable bytes/envelopes, write recovery evidence or log a spend.
Normal execution reserves a durable zero-amount fee-bearing hold before signing,
then exclusively creates `gryd-listings/<txid>.json` with mode `0600` and fsync
**before** `defaultBroadcast`. Evidence includes signed bytes, source outpoint,
input/output amounts, operation, route ID, payment ID and public property identity;
never private keys. Existing evidence is never overwritten. Protect these files
as spendable authorizations. Filesystem ACLs and Windows directory-fsync/power-loss
limitations still apply. An ambiguous broadcast, txid mismatch or persistence
failure retains the hold, with no automatic retry or recovery/clearing command.
The existing ARC transport's explicit fee-policy fallback remains unchanged.

After acknowledged broadcast the CLI prints a property-key signed envelope:

- `agent.list`, `POST /api/v1/agents/<id>/list`, body
  `{ price_sats, listing_type: "sale", outpoint: "<listTxid>_0", list_txid }`.
- `agent.cancel_listing`, `POST /api/v1/agents/<id>/listing/cancel`, body `{}`.

The ID is URL-encoded exactly. These envelopes are **never POSTed** by Dogfood;
they are usable short-lived authorizations, not receipts. No live broadcast or
backend mutation is performed by tests. The real QA chain fixture validates
listing-script byte identity; disposable synthetic list/cancel transactions
validate all inputs and intercepted transport/evidence ordering separately.

## Gryd origination (Phase 4: wallet-verified chain, backend metadata mirror)

```bash
# Rehearsal: select a disposable UNFUNDED vault and intercept all network calls.
bun src/cli.ts agent-mint <name> <lat> <lng> --no-broadcast
bun src/cli.ts agent-register <mint-txid> <name> <lat> <lng> --no-post
```

**Without the flags, mint broadcasts on mainnet and register POSTs a backend
mutation.** Both are human CLI-only, never MCP. Tests mock every broadcast and
HTTP mutation; no live mint/registration acceptance is claimed. No Gryd code or
service is changed. Phase 3's separate cancellation/payout verifier limitation
still applies to listings; a wallet-valid fresh-mint listing is not proof of
backend listing acceptance.

`agent-mint` uses main-address coins **greater than one sat**, smallest-first.
It checks each source transaction hash, output index, amount and exact main
P2PKH script, and refreshes the unspent triples before signing. Output 0 is
exactly one sat to the isolated PROPERTY derivation
`dogfood/gryd/property/v1`; output 1 is main-address change. All outputs are
self-controlled: only the actual miner fee leaves the wallet. Like owner split
and listing, mint bypasses purchase/allowlist/BRC-181 destination budgets, records
amount zero and actual fee, but obeys STOP_SPENDING and the shared payment guard.
Every signed input is validated with SDK `Spend` before broadcast.

The script is `OP_FALSE OP_IF "ord" OP_1 "application/json" OP_0 <UTF-8 JSON>
OP_ENDIF <property P2PKH>`. The chosen payload, in this exact key order, is:

```json
{"name":"Scout","class":"AGENT","rarity":"common","lat":12.5,"lng":-20}
```

This is **Dogfood's explicit application metadata choice**, matching accepted
Gryd Object fields; it is not an existing canonical Gryd inscription/indexer
schema. Class `AGENT` is required for the backend Object-to-agent projection.
The real QA origin fixture is different: `text/plain` containing exactly
`Gryd Market close-E2E fixture (burnable)`. Its original entire script is
reproduced byte-for-byte in a separate test, not falsely attributed to the new
JSON format. Names must be trimmed valid UTF-8, 1–200 bytes without controls;
lat/lng must be finite and within ±90/±180. CLI coordinates accept signed decimal
notation only, not whitespace, hex or exponents. Txids are lowercase 64-hex;
extra/duplicate flags and malformed arguments fail before key access.

Mint preview performs reads and temporarily acquires the lock but does not sign,
reserve, write spendable evidence, emit raw bytes or broadcast. Normal mint
reserves before signing and exclusively creates mode-0600, fsynced
`gryd-mints/<txid>.json` **before** broadcast. It contains signed bytes, metadata,
input/output amounts, payment ID and property public identity, never private keys.
A timeout, wrong acknowledgement or persistence failure retains the hold. No
automatic retry/rebroadcast or clearing command is added. Existing ARC behavior
(including its explicit fee-policy fallback) is unchanged.

### Exact registration contract

`agent-register` independently fetches the supplied raw mint from WoC, recomputes
its txid, verifies output 0 is one sat, verifies the **entire exact property
inscription script and JSON**, matches the supplied name/location, and checks
fresh script-hash unspent `(txid, 0, 1)` evidence. This is wallet validation using
chain/indexer reads, **not independent SPV or protection against a concurrent
spend**. Backend metadata never establishes on-chain ownership.

The property identity signs the existing canonical `Locus Signed Write\n`
format (compact base64 BSM). The fixed request is:

- **POST `https://the-grid-api.fly.dev/api/v1/objects/mint`**
- JSON wire envelope: `{ "payload": {...}, "signature": "...", "pubkey": "..." }`
- Payload: `{ mode: "signed_write", method: "POST", path: "/api/v1/objects/mint",
  action: "object.mint", body: <below>, timestamp: <Unix seconds>, nonce: <UUID> }`.
  No network override is exposed. The exact signed body is:

```json
{
  "txid": "<mint-txid>", "vout": 0,
  "name": "Scout", "class": "AGENT", "rarity": "common", "lat": 12.5, "lng": -20,
  "owner_address": "<derived-property-address>",
  "ordinal_outpoint": "<mint-txid>_0",
  "contentType": "application/json",
  "contentUri": "https://ordinals.gorillapool.io/content/<mint-txid>_0",
  "metadata": {"name":"Scout","class":"AGENT","rarity":"common","lat":12.5,"lng":-20}
}
```

The content URI is a locator, not evidence that an external indexer has indexed
or served it. `agent-call` remains restricted to the original agent action union;
the `object.mint` signer has a fixed internal route/action. This is **not**
`object.claim`, and not `POST /api/v1/agents` (which creates an off-chain agent).

**Authority boundary:** inspected `World.mint_object` inserts submitted metadata
and marks it ordinal without validating chain bytes or ownership. Signed-write
authentication authenticates the submitter; it does not make the backend an
ownership indexer. Dogfood supplies the chain validation above and treats the
backend strictly as a metadata mirror. It requires `{success:true,object:{id,...}}`,
checks returned fields for congruence, then reads
`GET /api/v1/agents/object%3A<ID>`. That profile must have the exact ID, source
`object`, matching owner and exact normalized mint output-zero outpoint. Every
present name/location/txid/class/content/metadata alias must agree; conflicting
camelCase/snake_case aliases fail closed. The backend profile omits some Object
fields; absence of those optional fields is not independently verified metadata.

### Registration intent, ambiguity and listing provenance

Before either POST **or printing a no-post authorization**, Dogfood exclusively
writes/fsyncs `gryd-registrations/<txid>.intent.json`. `--no-post` prints a signed
envelope, not an unsigned preview, and never POSTs. It leaves a per-mint intent
blocking blind reissuance/submission; it does not reserve a spending hold. Treat
that envelope as usable short-lived remote authorization. Normal POST additionally
reserves a zero-amount shared hold. HTTP response evidence goes to
`<txid>.response.json`; received profile evidence to `<txid>.profile.json`;
request/response transport failures get `<txid>.failure.json` when writable.
Malformed, rejected, inconsistent or ambiguous outcomes retain the intent and
shared hold. No automatic blind retry is possible.

Only a successful checked profile creates `gryd-registrations/<txid>.json` with
raw mint bytes, exact request body and `object:<id>` provenance. Completion is
followed by fsynced zero-amount accounting before releasing the guard. A repeat
on a completed registration rechecks the chain and known-ID GET **without POST**.
There is no invented public txid lookup or safe automatic discovery after a lost
response: stop spenders, retain all evidence, use a known returned ID for read-only
human reconciliation, and never remove holds merely to retry. No automated
ambiguous-state recovery/accounting repair is provided. Windows mode bits do not
replace filesystem ACLs; shared directory-fsync/power-loss limitations apply.

Fresh mint-to-list uses this checked registration provenance and the strict
inscription parser. It signs the **whole original source script**, never an
arbitrarily stripped suffix; every completed listing input is Spend-validated.
Missing/ambiguous provenance or unsupported wrappers fail closed. All protocol
vectors and prior agent-call behavior remain covered by the full test suite.

## Direct-send fee ceiling

`send <to-address> <sats> --max-fee <fee-sats> [note]` optionally bounds the
**actual miner fee**, not the payout. The signer validates each source transaction
and checks input value minus all outputs (including omitted zero/one-sat change)
before reserving, signing or broadcasting. Equality is accepted. Local payout caps,
allowlist, killfile and any signed BRC-181 policy still apply; the stricter fee
ceiling wins. This option never installs or modifies policy.

The flag must follow the address and payout, with a separate decimal-digits token
in the range 0 through 9007199254740991. Missing/duplicate flags, unknown options,
`--max-fee=500`, signs, fractions, exponent/hex notation and whitespace in the fee
token are rejected before funding lookup. Ordinary multiword notes still work;
use `--` before literal note tokens beginning with `-` (all remaining tokens then
become the note). Put the fee flag **before** that separator.

Library callers use `sendPayment({ ..., maxFeeSats })`: invalid caps return
`BAD_MAX_FEE` before vault/network access; excessive actual fees return `FEE_CAP`
before reservation/signing. These refusals leave no new payment hold or spend row.
Existing holds are never cleared. Ambiguous broadcast failures still retain holds;
see [payment recovery](docs/payment-recovery.md), and never automatically retry.
Omitting the option adds no new ceiling; local caps still count payout only.
This option is limited to direct-send API/CLI, not MCP or other rails. It is not a
preview, confirmation prompt, total-debit budget, or single-use approval token.
For a separately approved owner-operated payment, use the
[one-payment approval packet](docs/one-payment-acceptance.md).

## Paying HTTP 402

```bash
bun src/cli.ts x402-pay <url>
```

Tries rails in order — **BSV sats → Base USDC → Solana USDC** — switching only on `UNSUPPORTED`, never after a policy, funding, or settlement refusal. Every rail goes through policy first: per-asset caps, destination allowlist, killfile. Successful payments log spend rows and print the on-chain receipt.

- **BSV** (`bsv-direct` scheme, BRC-0121-flavored): the client builds and signs the full transaction; the merchant validates and broadcasts. 0-conf accepted for sub-cent prices.
- **Base USDC** (x402 `exact`, EIP-3009): signed `transferWithAuthorization` settled by a facilitator — ours can be self-hosted (below), so no Coinbase account or business entity is needed.
- **Solana USDC** (x402 `exact`): partially-signed versioned transaction; the merchant co-signs as fee payer and submits, so the payer needs no SOL.

## Running a merchant

```sh
DOGFOOD_MERCHANT_PAYTO=0x… \
DOGFOOD_MERCHANT_BSV_PAYTO=1… \
bun src/cli.ts merchant 8410
curl -i http://127.0.0.1:8410/v1/fortune   # → 402 with a price menu
```

Env knobs: `DOGFOOD_MERCHANT_PRICE` (USDC base units), `DOGFOOD_MERCHANT_NETWORK` (`base` / `base-sepolia`), `DOGFOOD_MERCHANT_BSV_SATS` (default 500), `DOGFOOD_MERCHANT_SOL_NETWORK` (`solana` / `solana-devnet`), `X402_FACILITATOR_URL`, `DOGFOOD_SELF_FACILITATE=1` (settle Base yourself: gas from the vault's ETH, key never leaves the machine), `DOGFOOD_MERCHANT_STATE` (replay ledger path — file-backed, survives restarts, append-before-broadcast).

The merchant validates before settling: amount, payee, mint, unspent inputs, nonce reuse, signature recovery, replay ledger reservation. A `Dockerfile.merchant` + `fly.toml` deploy the keyless public variant (BSV-direct + testnet USDC) in one `fly deploy`.

## MCP

```bash
bun src/cli.ts mcp
```

Claude Desktop example (replace all absolute paths; no client `cwd` support assumed):

```json
{
  "mcpServers": {
    "dogfood-wallet": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/dogfood-wallet/src/cli.ts", "mcp"],
      "env": { "DOGFOOD_WALLET_DIR": "/absolute/path/to/selected/vault" }
    }
  }
}
```

Use your client's documented config schema, with the same absolute executable/script paths and explicit vault environment. See the [connection walkthrough](docs/quickstart.md#4-connect-one-agent-choose-stdio-or-http).

`x402_pay({ url })` uses the same payment orchestration as CLI `x402-pay`: **BSV sats → Base USDC → Solana USDC**, falling through only on `UNSUPPORTED`. Policy, funding, and settlement errors stop immediately. Caps, allowlists, killfile, optional BRC-181 envelope checks on every rail, and per-asset spend logs apply on both surfaces. Base and Solana require human-configured `evm.usdc` / `solana.usdc` policy blocks. Success returns the selected rail's CLI result shape; failures return `isError: true` with `{ ok: false, code, message }`.

HTTP (loopback, stateless POST `/mcp`):

```bash
bun src/cli.ts mcp-http
```

Default `http://127.0.0.1:38402/mcp`. Override `DOGFOOD_MCP_HOST` / `DOGFOOD_MCP_PORT`. Binding anything other than loopback **requires** `DOGFOOD_MCP_TOKEN` (Bearer). Health: `GET /health`. Same tools as stdio — no `allow`, no `sweep`. Do not put this on Fly without the token; the signer is on this machine.

## Policy

| Gate | Result |
|---|---|
| Empty / miss allowlist | `REJECTED: Allowlist is empty` / `not on the allowlist` |
| Amount > per-tx cap | `REJECTED: Exceeds cap of N sats/tx` |
| Daily cap | `REJECTED: Exceeds daily cap of N sats (spent X, requested Y)` |
| Lifetime cap | `REJECTED: Exceeds lifetime cap of N sats` |
| Killfile on | `REJECTED: Killfile STOP_SPENDING is on` |
| Bad address | `REJECTED: Destination is not a mainnet P2PKH address` |
| Empty vault | `REJECTED: Insufficient funds` |

USDC rails have their own blocks (`evm.usdc`, `solana.usdc`) with the same allowlist + killfile semantics. The signer fails closed. The agent should pivot (cheaper source, stop), not retry with a new wallet.

## Payment concurrency and recovery

CLI/MCP `send`, `x402-pay` and `x402-delegate`, plus owner-only `split` and `allowance-fund`, share a per-vault cross-process lock acquired before policy/usage reads. A durable pending intent is recorded before signing; uncertain outcomes retain a hold instead of permitting another payment. Successful payments release it only after durable spend accounting. Split records zero transferred amount and its miner fee separately: all outputs return to the vault, and no amount or fee is charged to daily/lifetime spend caps. Kill still blocks split. Inspect without unlocking with `bun src/cli.ts payment-inspect`.

Owner `bridge-rebalance` shares the lock for guarded funding; explicit owner `bridge-reconcile` verifies settlement before releasing exposure (see below). This does **not** cover direct lower-level library helpers, `sendRaw`, fee delegator or merchant replay state. Allowance funding preserves private per-funding recovery records before broadcast and releases only after durable accounting and a completion marker. Do not run excluded spenders concurrently with guarded payments or use them to bypass a hold. Emergency owner `sweep` and `allowance-sweep` deliberately bypass the guard; **stop all spenders first** because sweeping does not cancel an in-flight payment. Kill remains available. There is no automatic hold expiry or clear command. See [payment recovery and scope limitations](docs/payment-recovery.md) before operating unattended.

## Bridge: guarded funding and owner reconciliation

`bridge-rebalance [sats]` creates one order and deposits once under the shared
payment guard. Without an amount, the configured low-water threshold applies.
It returns `awaiting-reconciliation`, **not** completed-swap success. Ambiguity
retains a durable exposure hold; never retry the deposit automatically.

`bridge-status [orderId|intentId]` is local and read-only. Explicit owner
`bridge-reconcile <intentId>` validates the exact provider order, independently
confirmed BSV deposit and native Base USDC receipt/log evidence, writes actual
arrival accounting exactly once, and releases only its own exclusive transition.
The Base receipt must be newer than a canonical block boundary pinned durably
before order creation. This prevents historical receipt replay, **not** dishonest
provider attribution of a contemporaneous transfer: the provider still asserts
the deposit/order/payout relationship. Signed BRC-181 budgets combine ordinary
and bridge BSV debits (principal plus fees); local policy caps stay separate.
It never steals a live or abandoned execution lock. Emergency sweeps remain
available and do not erase holds/history. All bridge commands remain off MCP.

See [bridge lifecycle and limitations](docs/bridge-lifecycle.md) and
[official provider contracts / synthetic fixture provenance](docs/bridge-provider-contracts.md).
This branch has offline synthetic coverage, **not live funded acceptance or
provider compatibility proof**. Legacy order-only quarantine records remain
held and are not silently migrated into funded evidence.

## Merkle Works x402 (payer)

```bash
bun src/cli.ts x402-inspect <X402-Challenge>
bun src/cli.ts x402-proof <X402-Challenge> <rawtx-hex>
bun src/cli.ts x402-delegate <X402-Challenge>
```

Uses frozen vectors from `testdata/x402-vectors-v1.json` (canonical JSON, SHA-256, base64url, header binding, body hash, Bitcoin txid).

`x402-delegate` POSTs `{partial_tx}` to `$DOGFOOD_X402_DELEGATOR_URL/delegate/x402` (Merkle Works wire format), then builds `X402-Proof`. Unset URL → `NEED_DELEGATOR` (no fetch, no demo host). Policy still gates the payee. Broadcast is **off** unless `--broadcast` or `DOGFOOD_X402_BROADCAST=1`. Default sponsored mode does not sign or spend vault coins and never logs a local spend. `--vault-fund` (MCP `vault_fund: true`) **does spend local coins**. Both modes respect an existing payment hold.

Guarded client funding is deliberately bounded: one funding UTXO with positive change, source hash/value/script verified, and **SIGHASH_ALL|FORKID|ANYONECANPAY (0xC1)** to commit the payee and change. The delegator may append fee inputs, **not outputs/change**. The old SINGLE signature commits only the paired change output, not the payee; validating a later response cannot undo an unsafe signature already sent. Multi-UTXO, exact-value, and output-appending client completions are unsupported here (the low-level legacy fixture helper remains available, not agent-wired). This may reject existing delegators that require their own change output; no compatibility or live-settlement claim is made.

Before signing, intent is durably recorded. Signed bytes sent to a delegator are spending exposure **even when broadcast is off**: that path returns `PAYMENT_HELD`, no proof-as-success and no completed-spend row, and retains the hold for human reconciliation. Opt-in broadcast releases only after validating completed transaction bytes/ID, payee, unchanged client inputs/outputs, source values/scripts, input signatures, no extra local funding, exact vault debit, matching broadcaster ID, and durable accounting. Ambiguity, rejection, signing/log failure, or process death stays held. Sponsored templates are checked for local inputs before forwarding; completed sponsored transactions are validated but never charged to vault usage.

## BRC-0204 (script + descriptor, not a live allowance)

[BRC-0204](https://bsv.brc.dev/wallet/0204) is a two-branch lock: the agent spends with `OP_1`, the owner sweeps with `OP_0`, plus a 1-sat revocation output. Dogfood **funds and owner-sweeps** that shape. Locking keys are Type42-derived (`protocolID` `[2, "agent allowance"]`, `keyID` = `allowanceId`, counterparty = agent identity). The vault key is the owner **identity**, not the key on the lock. Fund also issues a BRC-52 core certificate (type = SHA-256 of `agent allowance`) signed by the owner, bound to the revocation outpoint. Field revelation keyring stays on disk; it is not printed. `proveAllowanceCertificate` (library, not CLI) lets an **agent `ProtoWallet`** reveal selected fields to a verifier. Never pass an agent WIF on a CLI.

```bash
bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
bun src/cli.ts allowance-inspect <descriptor-json-or-file>
```

Human-only. Not MCP. Owner identity is the vault key. Allowance locking keys are Type42 children. Agent identity is the pubkey you pass in.

```bash
bun src/cli.ts allowance-fund <agent-pubkey-hex> <sats> [pieces]
bun src/cli.ts allowance-list
bun src/cli.ts allowance-sweep [p2pkh-address]
bun src/cli.ts allowance-sweep --record <record-id> [p2pkh-address]
```

`allowance-fund` spends vault coins into the two-branch lock plus a 1-sat revocation output. Counts against sat caps. Killfile blocks it. Empty allowlist does **not** (destination is a script). `allowance-sweep` spends the owner branch + revocation even if the killfile or payment hold is on. **Stop all spenders first.**

New funding writes immutable, private `allowances/<funding-txid>.json` (signed transaction, descriptor, certificate and master keyring) before broadcast, and `<funding-txid>.accounted.json` only after matching broadcaster acknowledgement and fsynced accounting. Repeated funding never replaces earlier records. `allowance-list` is sanitized/offline; its `accounted` status is a local completion marker, not confirmation or unspent status. Results/CLI output exclude the master keyring. New files request mode 0600 and the directory 0700; Windows owners must protect the vault with filesystem ACLs.

Existing `allowance.json` is read in place as record ID `legacy`, never overwritten or silently migrated. Missing historical descriptors/keyrings cannot be reconstructed. With multiple records, sweeping requires `--record <funding-txid>` or `--record legacy`; the default refuses ambiguity. Sweeps preserve all history and do not resolve funding holds. Explicit selection can recover a valid record despite unrelated corrupt history. Ambiguous funding is **not retryable**: no automatic rebroadcast, accounting repair, hold clearing, or delegated allowance-spending feature is provided. See [recovery limits](docs/payment-recovery.md#allowance-funding-lifecycle).

## BRC-181 policy inspect

```bash
bun src/cli.ts policy-inspect <envelope-json-or-file>
```

Verifies a signed `brc-181/agent-policy/1` envelope against frozen vectors (`testdata/brc-181-vectors.json`). Canonical dests are `p2pkh:<hash160>` / `script:<sha256>` on BSV (OP_RETURN is not a dest), `evm:<lowercase address>` on Base, and `solana:<base58 address>` on Solana. Human-only inspect. Not MCP.

Mint an envelope with the vault key as issuer (human-only, not MCP):

```bash
bun src/cli.ts policy-issue --origin <token> --per-tx <n> --total <n> --max-fee <n> --purpose <text> \
  [--allow <dest>]... [--dest-cap <dest>=<n>]... [--expires <epoch>] [--write] [--force]
```

Prints the signed envelope JSON; `--write` installs it as the vault's `brc181.json` (refuses to replace an installed envelope without `--force`). Destinations are always prefixed canonical forms — `p2pkh:` / `script:` / `evm:` / `solana:` — never raw addresses, and `evm:` dests are lowercase. Caps are in the native units of the rail being charged. Review any installed envelope with `policy-inspect ~/.dogfood-wallet/brc181.json`.

If the vault contains `brc181.json`, **every payment rail verifies the envelope and enforces it** (AND with local `policy.json`): `send`, `x402-delegate`, and `x402-pay` on BSV, Base USDC, and Solana USDC alike. Numeric envelope fields are read in the native units of the rail's asset (sats on BSV, USDC base units on the dollar rails); the facilitator pays gas on USDC settles, so their client-side fee is 0. Origin is `DOGFOOD_ORIGIN_TOKEN` or the record's `origin_token`. Sweep/split ignore the envelope. A Vector A `max_fee` of 100 sats will reject a typical P2PKH fee — issue a record with a real fee cap. x402-delegate charges local fee 0 because its sponsor covers fees; client-funded mode still debits and accounts the challenge amount. Envelope budgets draw from their own per-rail log scopes (`brc181-bsv`, `brc181-usdc-base`, `brc181-usdc-solana`), kept separate from ordinary policy usage.

## Not this

- Not the shared Hermes QA treasury (`1Gjc…`). That key stays private.
- Not Yours Wallet / BSV Association mobile (those are for humans).
- Not Coinbase-style hosted custody.
- Not an x402 **gateway**. Merkle Works [x402 v1](https://github.com/ruidasilva/merkleworks-x402-spec) is the BSV paywall we intend to *pay*. We do not vendor their Go gateway.
- Not a business. MIT, free forever, no revenue cut built in.

## Later

- Live Merkle Works delegator URL (you set `DOGFOOD_X402_DELEGATOR_URL`; we do not start their gateway)

## Dev

```bash
bun install --frozen-lockfile
bun run verify  # strict root TypeScript check, then full Bun tests
```

`bun run typecheck` checks all `src/**/*.ts`, including tests and subprocess
fixtures. The independent JavaScript site uses its own lockfile:

```bash
cd site
bun install --frozen-lockfile
bun test
bun run build
```

See [local release verification and remaining gates](docs/release-verification.md).

MIT. Keys never belong in git, logs, or MCP responses.
