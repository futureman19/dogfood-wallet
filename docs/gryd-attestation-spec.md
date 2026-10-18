# Dogfood Attestation v1

**Owner CLI only. Cryptographic authenticity, not observation truth.** This is a
new Dogfood application format, not a new Locus signed-write action, Gryd API
registration, weather service, selling endpoint, feed or oracle consensus. No
Gryd source or shared protocol is modified. Anyone controlling a key can sign a
false observation. Never treat an agent ID, API locator or sensor label as proof
of that entity's authority, honesty, location or measurement accuracy.

## Observation schema

The object has exactly these fields (all required):

```json
{
  "type": "weather.reading",
  "lat": 12.5,
  "lng": -20,
  "observedAt": "2026-01-02T03:04:05.000Z",
  "source": { "kind": "sensor", "ref": "station:synthetic-1" },
  "payload": { "temperatureC": 21 },
  "agent": { "id": "synthetic:scout", "ownerAddress": "<property P2PKH address>" }
}
```

- `type`: 1–96 UTF-8 bytes, matching
  `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$`. `weather.reading` is the initial
  use; `presence.attestation`, `event.report`, and future namespaced types use
  **the same envelope**, without changing its schema. Names do not imply any
  external registry endorsement. Unknown types satisfying this syntax are valid.
- `lat`, `lng`: finite JSON numbers, inclusive ±90 and ±180. No rounding.
- `observedAt`: actual calendar-valid UTC instant, exactly
  `YYYY-MM-DDTHH:mm:ss.sssZ`. Offsets, absent milliseconds, leap-second `60`, and
  normalized impossible dates are rejected. This is the signer's assertion of
  observation time, not trusted time, receipt time or signed-write freshness.
  Historical and future timestamps are permitted; no 300-second authorization
  window is applied to durable observations.
- `source`: exactly `kind` (`api`, `sensor` or `human`) and `ref` (nonempty valid
  UTF-8, at most 1024 bytes, no ASCII controls or DEL). A ref is inert text;
  **no ref is fetched**, even if it looks like a URL. Never include credentials.
- `payload`: a plain JSON object, with extensible application-specific data.
  Arrays, objects, strings, finite numbers, booleans and null may be nested.
  Weather units are explicit payload keys, e.g. `temperatureC`; the core verifier
  does not assert a weather-specific schema or validate physical plausibility.
- `agent`: exactly `id` (nonempty UTF-8, at most 200 bytes, no ASCII controls/DEL)
  and `ownerAddress` (valid **mainnet P2PKH base58 address**).
- Maximum canonical observation: **32,768 UTF-8 bytes**. Traversal visits at most
  4096 values, depth at most 16 (observation root depth zero), before serialization.
  Reject cycles, non-finite numbers, non-JSON values, sparse/custom arrays,
  accessors, symbols, custom prototypes, non-enumerable data, invalid Unicode
  surrogates, and keys `__proto__`, `constructor`, `prototype` at any depth.
  The signed wrapper has a separate bounded allowance for its three fields.
  Extra top-level/source/agent/wrapper fields are rejected, not ignored.

CLI accepts one inline JSON argument, at most 32,768 bytes before parsing, not a
filename or arbitrary URL. It follows JSON.parse semantics on input; duplicate
JSON keys therefore resolve to their last value before schema validation and
signing. No textual JSON is signed without parsing and normalization. On-chain
wrapper bytes must match the exact reserialization below, so duplicates,
whitespace and alternate field order in inscriptions are rejected.

## Identity binding and trust limits

`ownerAddress` means **the observation signer's property P2PKH address**, not the
parent/payment address, a Gryd backend's public-key owner field, or an assertion
that the signer owns a named agent. Minting derives the existing property key:

```ts
vault.key.deriveChild(vault.key.toPublicKey(), "dogfood/gryd/property/v1")
```

The supplied ownerAddress must equal this derived key's mainnet address before
any observation signature. Output zero locks to that same property address. The
public verifier derives an address from the supplied compressed public key,
requires equality with `observation.agent.ownerAddress`, verifies the signature,
and rebuilds the complete inscription with exactly that locking address.

This proves control of the signing key and its binding to the inscription's
original locking destination. The verifier **cannot prove the key was derived
from a particular parent vault**, that `agent.id` belongs to that key, current
UTXO ownership, agent authorization, source authenticity or physical truth.
There is no parent-owner assertion or certificate in v1. Transferred outputs are
not supported as new origins; verification targets the original mint's output 0.

## Pinned canonical source, quoted verbatim

Read-only source was obtained with:

```sh
git -C C:/Users/futur/Desktop/the-grid-open-world show origin/dev:packages/locus-protocol/src/signed-write.ts
```

- `origin/dev` resolved to **`e6763c71f75a12acf8df3529e4ccc3fd50b16d80`**.
- Git blob bytes, SHA-256:
  **`49eb1af56c138d819032df175f63952d9cd26e48657c9e8332a234c463e53ad5`**.
- Path: `packages/locus-protocol/src/signed-write.ts`.

Exact source quotations:

```ts
export const SIGNED_WRITE_MESSAGE_PREFIX = 'Locus Signed Write\n';
```

```ts
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
```

```ts
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

The existing wallet canonical serializer is exported and **reused**, not replaced.
For the supported JSON domain it directly serializes recursively sorted keys
using JS `Object.keys(...).sort()` (UTF-16 code-unit lexicographic order), no
whitespace; arrays retain order; primitive/key encoding uses `JSON.stringify`.
Thus `"10"` precedes `"2"`; do not stringify a reconstructed sorted object to
produce signed bytes, because JavaScript enumerates integer-looking keys
numerically. Numbers follow ECMAScript JSON formatting (including -0 → 0 and
exponent formatting); Unicode is not normalized. Reject lone surrogates before
serialization. Do not substitute RFC 8785 or locale-aware sorting.

**Domain separation is explicit, intentional and application-local:**

```text
UTF8("Dogfood Attestation v1\n" + canonicalJson(observation))
```

The prefix contains a single LF byte (0x0a), no CR/BOM or trailing newline. This
is the complete message passed to `@bsv/sdk` Bitcoin Signed Message signing,
which applies the standard Bitcoin Signed Message framing/hash. The signature
covers **every observation field recursively**, including type, coordinates,
time, source, payload and agent identity. It does not sign a subset/weather-only
payload. This is **NOT** `Locus Signed Write\n`, does not have action/method/path/
nonce/audience fields and cannot serve as a Locus signed-write authorization.
The existing signed-write prefix and envelope rules remain unchanged.

## Signed wrapper and exact inscription

The wire object is exactly `{ observation, pubkey, signature }` in that insertion
order. `observation` is `JSON.parse(canonicalJson(validatedObservation))`.
`pubkey` is compressed 33-byte lowercase hex. `signature` is the SDK's 65-byte
compressed compact BSM signature encoded in canonical base64 (88 characters,
final `=`); header 31–34. Verify ECDSA **and** the compact recovery header against
the supplied key. SDK `BSM.verify` alone ignores that header.

The UTF-8 inscription payload is exactly:

```ts
JSON.stringify({ observation, pubkey, signature })
```

This transport JSON is intentionally distinct from the signed canonical message:
JSON.stringify enumerates numeric-looking observation keys numerically. The
verifier reparses and recomputes canonical bytes for the signature, then requires
the transport bytes to match the exact serialization above. No raw transaction
or additional metadata is included in the on-chain payload.

Reuse `gryd-mint.ts:inscriptionScript` without alteration:

```text
OP_FALSE OP_IF <"ord"> OP_1 <"application/json"> OP_0 <UTF-8 wrapper JSON>
OP_ENDIF <property P2PKH>
```

All push encodings and the complete script are checked by byte-for-byte rebuild;
no suffix stripping, alternate pushes, extra opcodes, content types or wrappers.
Only output 0, worth **exactly one satoshi**, is supported. This is the Phase 4
script template with a different application payload, not a claim that original
QA fixture text was attestation JSON.

## CLI and library

```sh
# Supply the known isolated PROPERTY address, not the root payment address.
# Rehearsals must use throwaway unfunded vaults and mocked network.
bun src/cli.ts agent-attest '{"type":"weather.reading","lat":12.5,"lng":-20,"observedAt":"2026-01-02T03:04:05.000Z","source":{"kind":"sensor","ref":"station:synthetic-1"},"payload":{"temperatureC":21},"agent":{"id":"synthetic:scout","ownerAddress":"<property-address>"}}' --no-broadcast

# Public verification: no vault, keys, writes, source-ref fetches or unspent lookup.
bun src/cli.ts agent-attest-verify <lowercase-64-hex-mint-txid>
```

**Omitting `--no-broadcast` spends mainnet miner fees and publishes the observation
permanently.** Both commands are absent from MCP (tested through real SDK discovery
and call rejection). Unknown/repeated flags and invalid JSON/schema/txids fail
before vault access. Library: `validateObservation`, `canonicalAttestationMessage`,
`signObservation(value, explicitKey)`, `verifyAttestation(wrapper)`,
`attestAgent({root,observation,noBroadcast?,fetchFn?,broadcast?})`, and
`verifyAttestationTx(txid,fetchFn?)`. Explicit-key helpers do not consult a vault;
they establish key/address equality, not the caller's property derivation.

Preview does funding reads, derives public identity and temporarily acquires the
shared lock, but makes **neither BSM nor transaction signatures**, reserves no
intent, writes no evidence or accounting, and prints no raw bytes/signatures.
It returns decoded observation, inputs, output destinations/roles, minerFee and
`mode:"preview"`. A same-length non-signed internal placeholder estimates the
final wrapper size. Broadcast mode returns those decoded details plus txid and
`mode:"broadcast"`, not spendable raw bytes. ARC acknowledgement is not mining
confirmation; no Gryd registration or HTTP API mutation is performed.

## Transaction safety and durability

| Position | Key/value | Rule |
|---|---|---|
| Inputs | main payment key, values >1 | smallest-first, txid/vout/value and exact main P2PKH checked from raw transactions |
| Output 0 | property key, 1 sat | exact JSON ordinal template above |
| Output 1 | main payment address | positive self-change |
| Fee | input total minus both outputs | estimated at established 1 sat/byte; actual fee reserved/accounted |

Fresh address unspent triples must still include every input immediately before
signing. STOP_SPENDING is checked initially and again after those asynchronous
reads. Shared guard reservation precedes **both** observation and transaction
signing. Every completed input is checked with SDK `Spend.validate()`.

Like the existing owner mint/split path, all outputs are self-controlled; no
purchase, local allowlist or BRC-181 destination budget is used. This is deliberate
human-only owner operation semantics, not autonomous spending permission.
Accounting is `kind:"agent-attest", asset:"bsv", amount:0, fee:<actual miner fee>`.
The 1 sat moves into the isolated property output; only miner fees leave the vault.
Other payment lanes and their gates are unchanged.

Before broadcast, exclusively create `gryd-attestations/<txid>.json` (`wx`, mode
0600; directory mode 0700), write and fsync signed transaction, signed observation,
decoded input/output amounts, public identity/derivation and payment ID. Never
replace evidence. Fsync directory on supported systems. Windows mode bits are not
ACLs and Windows directory-fsync/power-loss limitations from the shared payment
guard remain; protect the vault with filesystem ACLs. Evidence includes usable
spending authorization but no private keys.

Persistence/signing/input validation failures after reservation, lost responses,
wrong broadcast IDs and ambiguous outcomes retain the shared hold. Success logs
and fsyncs accounting before releasing it. There is no automatic retry, hold
expiry, rebroadcast, recovery or clearing command. Existing ARC explicit
fee-policy-rejection fallback to WoC is preserved; ambiguous errors never fall
back. Never delete a hold to try again: stop spenders, preserve evidence, and
reconcile chain state and accounting manually. An accepted mint may still become
invalidated by a conflicting spend; no SPV guarantee is made.

## Public verification and bounded I/O

Fetch only the fixed WoC mainnet `/tx/<validated-txid>/hex` URL. Recompute raw hash,
require exact transaction reserialization, parse only the exact supported output
zero script, validate bounded schema, reconstruct canonical signed bytes, verify
BSM plus recovery-header binding and exact destination equality. No vault function
is called, no files written, and no identity registration/index lookup occurs.

Every network call in this lane uses redirect `error` and a **30-second deadline
covering fetch and response body**, with a streamed **2 MiB maximum response**.
Oversize/malformed/unavailable reads fail closed. Maximum supported inscription
script size is observation limit plus 1024 bytes. No arbitrary source URL is
followed. This bound also applies to funding reads and broadcast response bodies.
Indexer responses are not independently authenticated SPV evidence.

Successful verifier output includes:

```json
{
  "authentic": true,
  "txid": "<hash-checked transaction id>",
  "outpoint": "<txid>_0",
  "observation": { "...": "validated complete observation" },
  "propertyAddress": "<signer and locking address>",
  "pubkey": "<compressed public key>",
  "truthVerified": false,
  "unspentChecked": false,
  "confirmationChecked": false
}
```

These false fields are intentional: authentic signatures do not verify weather,
source truth, original agent ownership, current unspent status, confirmation or
finality. Location/payload/source strings are untrusted public data; never execute
or render them as HTML, and avoid publishing sensitive location trails.

## Reproducible evidence

`testdata/gryd-attest-vectors.json` freezes three synthetic vectors (public scalar
1, **never fund**) produced by executing `canonicalJson` from the pinned git blob,
not by a guessed implementation. Includes source SHA-256, commit, canonical
strings, UTF-8 bytes, public keys and deterministic BSM signatures. Regenerate:

```sh
# Set TEMP, TMP, TMPDIR to active-profile scratch first.
bun scripts/gryd-attest-vectors.ts C:/Users/futur/Desktop/the-grid-open-world
```

The generator uses `git show <pinned-sha>:<path>`, runs a scratch copy of that
source, and never changes the reference checkout. Packaged runtime and tests have
no sibling-checkout dependency. Tests use disposable vaults only, intercept all
broadcasts/network, and cover canonical parity, every observation-field tamper,
signature/header/key/destination mismatch, strict schemas and script matching,
funding and kill rechecks, holds/evidence order, unsigned previews, real CLI and
MCP isolation. No live broadcast, source-weather reading or mainnet acceptance was
performed for this implementation.
