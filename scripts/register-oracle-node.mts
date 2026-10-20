// One-off: register the Gryd Weather Oracle as node #1 on the production
// registry. Signs a WriteEnvelope node.create with the vault's derived
// property key (the oracle pin's controlling key) and POSTs to prod.
// Never prints key material. Run: bun scripts/register-oracle-node.mts
import { BSM, Utils } from '@bsv/sdk';
import { loadVault } from '../src/vault';
import { defaultVaultDir } from '../src/vault';
import { propertyKey } from '../src/gryd-buy';

const BASE = 'https://the-grid-api.fly.dev';
const AUDIENCE = 'the-grid-api.fly.dev';
const PIN = '77ff07a178a96f7108cbf44604c0b18989a1c37e3bf17216bd9d0e36261f43a5.0';

// Byte-parity canonical JSON (same semantics as the backend WriteEnvelope):
// sorted keys recursively, standard JSON encoding, no whitespace.
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v) as string;
}

const vault = loadVault(defaultVaultDir());
const key = propertyKey(vault.key);
const address = key.toAddress();
if (address !== '1637cqGko6EXy1y4a647M2YMA8eTdyJZDp') {
  console.error(JSON.stringify({ ok: false, error: `property key address mismatch: ${address}` }));
  process.exit(1);
}

const body = {
  requestId: crypto.randomUUID(),
  nodeId: crypto.randomUUID(),
  pin: PIN,
  archetype: 'weather.prediction@1',
  config: {
    metric: 'air_temperature_2m',
    unit: 'Cel',
    sourceRefs: ['nws:station/KNYC', 'open-meteo:gfs/central-park'],
    modelRef: 'gryd-weather-oracle/v0.1',
    resolutionSourceRef: 'nws:station/KNYC',
    resolutionRule: 'nearest-sample-earlier-on-tie@1',
    baselineMethod: 'persistence',
    targetHourUtc: 13,
    cadence: { kind: 'daily', hourUtc: 13 },
  },
};
const payload = {
  mode: 'signed_write', method: 'POST', path: '/api/v1/nodes', action: 'node.create', body,
  timestamp: Math.floor(Date.now() / 1000),
  nonce: crypto.randomUUID().replace(/-/g, ''),
  network: 'mainnet', audience: AUDIENCE,
};
const message = 'Locus Signed Write\n' + canonicalJson(payload);
const signature = BSM.sign(Utils.toArray(message, 'utf8'), key, 'base64') as string;
const wrapper = { payload, pubkey: key.toPublicKey().toString(), signature };

// Local pre-verification with the backend's exact cjs semantics.
const { PublicKey, Signature, BigNumber } = await import('@bsv/sdk');
const msgBytes = Utils.toArray(message, 'utf8');
const compact = Buffer.from(signature, 'base64');
const pub = PublicKey.fromString(wrapper.pubkey);
const sig = Signature.fromCompact(signature, 'base64');
const localValid =
  BSM.verify(msgBytes, sig, pub) &&
  compact.length === 65 && compact[0]! >= 31 && compact[0]! <= 34 &&
  sig.RecoverPublicKey(compact[0]! - 31, new BigNumber(BSM.magicHash(msgBytes))).eq(pub);
console.error(`local cjs-equivalent verify: ${localValid} | header ${compact[0]} | pubkey ${wrapper.pubkey.slice(0, 10)}…`);

const res = await fetch(BASE + '/api/v1/nodes', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(wrapper),
});
const text = await res.text();
console.log(JSON.stringify({ ok: res.status < 300, status: res.status, nodeId: body.nodeId, requestId: body.requestId, response: text.slice(0, 500) }, null, 2));
