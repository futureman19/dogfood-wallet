import { Hash, LockingScript, P2PKH, type PrivateKey, SatoshisPerKilobyte, Script, Spend, Transaction, TransactionSignature, UnlockingScript, Utils } from "@bsv/sdk";
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORD_LOCK_PREFIX, ORD_LOCK_SUFFIX } from "./gryd-ordlock-constants";
import { p2pkhAddressFromLock } from "./x402";
import { loadVault, loadUsage, vaultPaths } from "./vault";
import { evaluateSend, evaluateGrydBuy } from "./policy";
import { gateAgentSend, loadPolicyEnvelope } from "./brc181";
import { withPaymentGuard } from "./payment-guard";
import { defaultBroadcast, type Utxo } from "./send";
import { signAgentRequest, type SignedAgentRequest } from "./gryd-agent";

export const GRYD_FUND = "18Jc1Rq5Aw54UpCNLNvwoTLN4Uv5reTjCa";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const MARKET = "https://the-grid-api.fly.dev/api/v1/agents/market?limit=200";
const PROPERTY_DOMAIN = "dogfood/gryd/property/v1";

export function normalizeListingOutpoint(point: string): string {
  if (typeof point !== "string" || !/^[a-fA-F0-9]{64}[._](0|[1-9][0-9]*)$/.test(point)) throw new Error("Invalid listing outpoint: expected txid_vout or txid.vout");
  const normalized = point.replace(".", "_").toLowerCase();
  const index = Number(normalized.split("_")[1]);
  if (!Number.isSafeInteger(index) || index > 0xffffffff) throw new Error("Invalid listing output index");
  return normalized;
}
export function marketplaceFee(price: number): number {
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Price must be positive integer satoshis");
  return Number((BigInt(price) + 39n) / 40n);
}
/** Separate self-derived key domain. Never query this address for funding. */
export function propertyKey(key: PrivateKey): PrivateKey {
  return key.deriveChild(key.toPublicKey(), PROPERTY_DOMAIN);
}

/** Accept only the exact legacy covenant and one canonical P2PKH payout. */
export function decodeListing(hex: string): { price: number; payAddress: string; payoutScript: LockingScript } {
  if (!/^(?:[a-f0-9]{2})+$/.test(hex) || !hex.startsWith(ORD_LOCK_PREFIX) || !hex.endsWith(ORD_LOCK_SUFFIX)) throw new Error("Unsupported OrdLock listing");
  const middle = hex.slice(ORD_LOCK_PREFIX.length, -ORD_LOCK_SUFFIX.length);
  // canonical push20 cancellation hash, push34 serialized P2PKH output
  if (!/^14[a-f0-9]{40}22[a-f0-9]{68}$/.test(middle)) throw new Error("Noncanonical OrdLock payout");
  const payout = Buffer.from(middle.slice(44), "hex");
  const priceBig = payout.readBigUInt64LE(0);
  if (priceBig <= 0n || priceBig > BigInt(Number.MAX_SAFE_INTEGER) || payout[8] !== 25) throw new Error("Invalid OrdLock price or payout");
  const payoutHex = payout.subarray(9).toString("hex");
  const payAddress = p2pkhAddressFromLock(payoutHex);
  if (!payAddress) throw new Error("OrdLock seller payout must be P2PKH");
  return { price: Number(priceBig), payAddress, payoutScript: LockingScript.fromHex(payoutHex) };
}

function outputBytes(output: Transaction["outputs"][number]): number[] {
  return new Utils.Writer().writeUInt64LE(output.satoshis!).writeVarIntNum(output.lockingScript.toBinary().length).write(output.lockingScript.toBinary()).toArray();
}
/** Legacy @1sat/templates 0.0.30 purchase path; no seller signature. */
export function purchaseUnlock(tx: Transaction, inputIndex: number): UnlockingScript {
  if (inputIndex !== 0 || tx.outputs.length < 2) throw new Error("OrdLock requires input zero and ordered outputs");
  const input = tx.inputs[0]!;
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!, transactionVersion: tx.version,
    otherInputs: [], inputIndex: 0, outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff, subscript: source.lockingScript,
    lockTime: tx.lockTime, scope: 0xc1,
  });
  return new UnlockingScript().writeBin(outputBytes(tx.outputs[0]!))
    .writeBin(tx.outputs.slice(2).flatMap(outputBytes)).writeBin(preimage).writeOpCode(0);
}

function positiveSafe(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive safe integer satoshis`);
}
async function get(url: string, fetchFn: typeof fetch) {
  const response = await fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Read-only chain/market lookup failed: HTTP ${response.status}`);
  return response;
}
export async function sourceTransaction(txid: string, fetchFn: typeof fetch): Promise<Transaction> {
  const hex = (await (await get(`${WOC}/tx/${txid}/hex`, fetchFn)).text()).trim();
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(hex)) throw new Error("Invalid source transaction encoding");
  const tx = Transaction.fromHex(hex);
  if (tx.toHex() !== hex.toLowerCase() || tx.id("hex") !== txid) throw new Error("Source transaction hash/bytes mismatch");
  return tx;
}
export async function unspent(url: string, fetchFn: typeof fetch): Promise<Utxo[]> {
  const rows: unknown = await (await get(url, fetchFn)).json();
  if (!Array.isArray(rows)) throw new Error("Invalid unspent response");
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || !/^[a-f0-9]{64}$/.test(row.tx_hash) || !Number.isSafeInteger(row.tx_pos) || row.tx_pos < 0 || row.tx_pos > 0xffffffff || !Number.isSafeInteger(row.value) || row.value < 0) throw new Error("Invalid unspent triple");
    const id = `${row.tx_hash}_${row.tx_pos}`;
    if (seen.has(id)) throw new Error("Duplicate unspent outpoint");
    seen.add(id);
  }
  return rows;
}
async function resolveAgent(point: string, fetchFn: typeof fetch): Promise<string> {
  const data = await (await get(MARKET, fetchFn)).json();
  if (!Array.isArray(data?.listings)) throw new Error("Invalid Gryd marketplace index");
  const matches = data.listings.filter((row: { listing?: Record<string, unknown> }) => {
    const l = row?.listing;
    if (!l || typeof l.outpoint !== "string") return false;
    try { return normalizeListingOutpoint(l.outpoint) === point; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error("No unique Gryd agent listing in public index; refusing purchase");
  const l = matches[0].listing;
  if (l.status !== "open" || l.listingType !== "sale" || l.targetType !== "agent" || l.listTxid !== point.split("_")[0] || typeof l.agentId !== "string" || !l.agentId || l.agentId.length > 256) throw new Error("Not an open Gryd agent sale");
  // Index supplies route identity only. Price and payAddress ALWAYS come from chain.
  return l.agentId;
}

type Preview = {
  listingOutpoint: string; agentId: string; price: number; marketplaceFee: number; minerFee: number; propertyAddress: string;
  inputs: { outpoint: string; satoshis: number; role: string }[];
  outputs: { index: number; satoshis: number; address: string | null; role: string }[];
};
export type BuyResult = Preview & ({ mode: "preview" } | { mode: "broadcast"; txid: string; envelope: SignedAgentRequest });
export type BuyOptions = { root: string; listingOutpoint: string; maxPriceSats: number; noBroadcast?: boolean; fetchFn?: typeof fetch; broadcast?: (raw: string) => Promise<{ txid: string }> };

/** Human CLI only. Preview is unsigned; a failed broadcast is NEVER retried. */
export async function buyAgent(options: BuyOptions): Promise<BuyResult> {
  const point = normalizeListingOutpoint(options.listingOutpoint);
  positiveSafe(options.maxPriceSats, "max-price-sats");
  if (options.noBroadcast !== undefined && typeof options.noBroadcast !== "boolean") throw new Error("Invalid preview option");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return withPaymentGuard(options.root, "agent-buy", async guard => {
    const vault = loadVault(options.root);
    if (vault.policy.killfileOn) throw new Error("STOP_SPENDING is on");
    const [txid, indexText] = point.split("_");
    const index = Number(indexText);
    const listing = await sourceTransaction(txid!, fetchFn);
    const ordinal = listing.outputs[index];
    if (!ordinal || ordinal.satoshis !== 1) throw new Error("Listing must be a one-satoshi ordinal output");
    const decoded = decodeListing(ordinal.lockingScript.toHex());
    if (decoded.price > options.maxPriceSats) throw new Error("Chain price exceeds human max-price-sats");
    const marketFee = marketplaceFee(decoded.price);
    const amount = decoded.price + marketFee;
    positiveSafe(amount, "Total purchase price");
    const scriptHash = Utils.toHex(Hash.sha256(ordinal.lockingScript.toBinary()).reverse());
    const listingUrl = `${WOC}/script/${scriptHash}/unspent`;
    const checkListing = async () => {
      if (!(await unspent(listingUrl, fetchFn)).some(u => u.tx_hash === txid && u.tx_pos === index && u.value === 1)) throw new Error("Listing is spent or chain triple mismatch");
    };
    await checkListing();
    const loaded = loadPolicyEnvelope(vaultPaths(options.root).brc181);
    if (!loaded.ok) throw new Error(loaded.message);
    const usage = loadUsage(options.root);
    const spentTotal = loadUsage(options.root, new Date(), "brc181-bsv").spentLifetime;
    const gate = (fee: number) => {
      const scoped = vault.policy.gryd;
      if (scoped) {
        const local = evaluateGrydBuy(scoped, vault.policy.killfileOn, amount, loadUsage(options.root, new Date(), "gryd").spentToday);
        if (!local.ok) throw new Error(local.message);
      }
      for (const to of [decoded.payAddress, GRYD_FUND]) {
        if (!scoped) {
          const local = evaluateSend(vault.policy, amount, to, usage);
          if (!local.ok) throw new Error(local.message);
        }
        // Aggregate debit for both destinations: conservative per-destination caps.
        const signed = gateAgentSend({ envelope: loaded.envelope, to, amount, fee, spentTotal });
        if (!signed.ok) throw new Error(signed.message);
      }
    };
    gate(0);
    const agentId = await resolveAgent(point, fetchFn);
    const property = propertyKey(vault.key);
    const propertyAddress = property.toAddress();
    if (propertyAddress === vault.address) throw new Error("Property/payment key collision");
    const candidates = (await unspent(`${WOC}/address/${vault.address}/unspent`, fetchFn)).filter(u => u.value > 1).sort((a, b) => a.value - b.value || a.tx_hash.localeCompare(b.tx_hash) || a.tx_pos - b.tx_pos);
    const tx = new Transaction();
    tx.addInput({ sourceTXID: txid!, sourceOutputIndex: index, sourceTransaction: listing, unlockingScriptTemplate: { sign: async t => purchaseUnlock(t, 0), estimateLength: async t => purchaseUnlock(t, 0).toBinary().length } });
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(propertyAddress) });
    tx.addOutput({ satoshis: decoded.price, lockingScript: decoded.payoutScript });
    tx.addOutput({ satoshis: marketFee, lockingScript: new P2PKH().lock(GRYD_FUND) });
    tx.addOutput({ satoshis: 0, lockingScript: new P2PKH().lock(vault.address), change: true });
    let total = 0;
    let funded = false;
    for (const u of candidates) {
      const source = await sourceTransaction(u.tx_hash, fetchFn);
      const output = source.outputs[u.tx_pos];
      if (!output || output.satoshis !== u.value || output.lockingScript.toHex() !== new P2PKH().lock(vault.address).toHex() || `${u.tx_hash}_${u.tx_pos}` === point) throw new Error("Funding chain triple/script mismatch");
      total += u.value; positiveSafe(total, "Funding total");
      tx.addInput({ sourceTXID: u.tx_hash, sourceOutputIndex: u.tx_pos, sourceTransaction: source, unlockingScriptTemplate: new P2PKH().unlock(vault.key) });
      const fee = await new SatoshisPerKilobyte(1000).computeFee(tx);
      if (total >= amount + fee + 1) {
        tx.outputs[3]!.satoshis = total - amount - fee;
        tx.outputs[3]!.change = false;
        funded = true; break;
      }
    }
    if (!funded) throw new Error("Insufficient payment coins for purchase plus miner fee and change");
    const minerFee = total + 1 - tx.outputs.reduce((sum, o) => sum + o.satoshis!, 0);
    gate(minerFee);
    const preview: Preview = { listingOutpoint: point, agentId, price: decoded.price, marketplaceFee: marketFee, minerFee, propertyAddress,
      inputs: tx.inputs.map((input, i) => ({ outpoint: `${input.sourceTXID}_${input.sourceOutputIndex}`, satoshis: input.sourceTransaction!.outputs[input.sourceOutputIndex]!.satoshis!, role: i === 0 ? "listed ordinal" : "payment coin" })),
      outputs: tx.outputs.map((o, i) => ({ index: i, satoshis: o.satoshis!, address: p2pkhAddressFromLock(o.lockingScript.toHex()), role: ["property (isolated)", "seller payout", "Gryd marketplace fee", "payment change"][i]! })) };
    if (options.noBroadcast) return { ...preview, mode: "preview" };
    await checkListing();
    // Refresh kill/local policy immediately before signing; guard serializes spenders.
    if (loadVault(options.root).policy.killfileOn) throw new Error("STOP_SPENDING is on");
    guard.reserve({ asset: "bsv", amount, to: decoded.payAddress, fee: minerFee });
    await tx.sign();
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]!, previous = input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
      const spend = new Spend({ sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex, sourceSatoshis: previous.satoshis!, lockingScript: previous.lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, j) => j !== i), inputIndex: i, unlockingScript: input.unlockingScript!, inputSequence: input.sequence ?? 0xffffffff, outputs: tx.outputs, lockTime: tx.lockTime });
      if (!spend.validate()) throw new Error("Purchase input script validation failed; hold retained");
    }
    const rawTx = tx.toHex(), purchaseTxid = tx.id("hex");
    const envelope = signAgentRequest("agent.buy", { close_txid: purchaseTxid }, { method: "POST", path: `/api/v1/agents/${encodeURIComponent(agentId)}/listing/close` }, property);
    const directory = join(options.root, "gryd-purchases");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(join(directory, `${purchaseTxid}.json`), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, paymentId: guard.id, ...preview, txid: purchaseTxid, rawTx, propertyPubkey: property.toPublicKey().toString(), derivation: PROPERTY_DOMAIN }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    const acknowledgement = await (options.broadcast ?? (raw => defaultBroadcast(raw, fetchFn)))(rawTx);
    if (acknowledgement.txid !== purchaseTxid) throw new Error("Ambiguous broadcast acknowledgement; hold retained");
    guard.log({ t: new Date().toISOString(), asset: "bsv", kind: "agent-buy", txid: purchaseTxid, amount, fee: minerFee, to: decoded.payAddress, marketplaceFee: marketFee, feeAddress: GRYD_FUND, propertyAddress, listingOutpoint: point });
    return { ...preview, mode: "broadcast", txid: purchaseTxid, envelope };
  });
}
