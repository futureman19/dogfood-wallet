import { expect, test } from "bun:test";
import { Hash, P2PKH, PrivateKey, Script, Transaction, Utils, Spend } from "@bsv/sdk";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initVault, loadVault, allowDestination, loadUsage, killVault } from "./vault";
import { inspectPaymentHold } from "./payment-guard";
import { ORD_LOCK_PREFIX, ORD_LOCK_SUFFIX } from "./gryd-ordlock-constants";
import realPurchase from "../testdata/gryd-buy-mainnet.json";
import { buyAgent, decodeListing, propertyKey, normalizeListingOutpoint, marketplaceFee, GRYD_FUND, purchaseUnlock } from "./gryd-buy";
import { canonicalDest } from "./brc181";
import { issuePolicyEnvelope } from "./policy-issue";
const seller = PrivateKey.fromHex("2".padStart(64, "0")).toAddress();
const cancel = PrivateKey.fromHex("3".padStart(64, "0")).toAddress();
function listingScript(price = 1000) {
  const payout = new Utils.Writer().writeUInt64LE(price).writeVarIntNum(25).write(new P2PKH().lock(seller).toBinary()).toArray();
  return new Script().writeScript(Script.fromHex(ORD_LOCK_PREFIX)).writeBin(Utils.fromBase58Check(cancel).data as number[]).writeBin(payout).writeScript(Script.fromHex(ORD_LOCK_SUFFIX));
}
function source(script: Script, satoshis: number) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
  tx.addOutput({ satoshis, lockingScript: script });
  return tx;
}
function harness() {
  const root = mkdtempSync(join(tmpdir(), "gryd-buy-"));
  initVault(root, 100000);
  allowDestination(root, seller); allowDestination(root, GRYD_FUND);
  const vault = loadVault(root);
  const listing = source(listingScript(), 1);
  const funding = source(new P2PKH().lock(vault.address), 20000);
  const point = `${listing.id("hex")}_0`;
  const calls: string[] = [];
  let broadcastRaw = "";
  const hash = Utils.toHex(Hash.sha256(listing.outputs[0]!.lockingScript.toBinary()).reverse());
  const responses = new Map<string, unknown>([
    [`/tx/${listing.id("hex")}/hex`, listing.toHex()],
    [`/tx/${funding.id("hex")}/hex`, funding.toHex()],
    [`/script/${hash}/unspent`, [{ tx_hash: listing.id("hex"), tx_pos: 0, value: 1 }]],
    [`/address/${vault.address}/unspent`, [{ tx_hash: funding.id("hex"), tx_pos: 0, value: 20000 }]],
    ["https://the-grid-api.fly.dev/api/v1/agents/market?limit=200", { listings: [{ listing: { agentId: "agent/a", status: "open", listingType: "sale", targetType: "agent", outpoint: point, listTxid: listing.id("hex"), priceSats: 99999999 } }], count: 1 }],
  ]);
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url); calls.push(text);
    expect(init?.method ?? "GET").toBe("GET");
    const key = text.replace("https://api.whatsonchain.com/v1/bsv/main", "");
    if (!responses.has(key)) throw new Error(`Unexpected network: ${key}`);
    const body = responses.get(key);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const broadcast = async (raw: string) => { broadcastRaw = raw; return { txid: Transaction.fromHex(raw).id("hex") }; };
  return { root, vault, listing, funding, point, responses, calls, hash, fetchFn, broadcast, get raw() { return broadcastRaw; }, clean() { rmSync(root, { recursive: true, force: true }); } };
}
test("real mainnet Gryd QA purchase: exact covenant unlock bytes, ordinal lineage and fees", () => {
  const f = realPurchase;
  for (const item of [f.purchase, f.listing, f.funding, f.origin]) {
    const tx = Transaction.fromHex(item.rawHex);
    expect(tx.id("hex")).toBe(item.txid); expect(tx.toHex()).toBe(item.rawHex);
  }
  const tx = Transaction.fromHex(f.purchase.rawHex), listing = Transaction.fromHex(f.listing.rawHex), funding = Transaction.fromHex(f.funding.rawHex);
  expect(listing.inputs[0]!.sourceTXID).toBe(f.origin.txid);
  expect(Buffer.from(f.origin.rawHex, "hex").includes(Buffer.from("Gryd Market close-E2E fixture (burnable)"))).toBe(true);
  expect(tx.inputs[0]!.sourceTXID).toBe(f.listing.txid);
  expect(tx.inputs[0]!.sourceOutputIndex).toBe(f.listingVout);
  tx.inputs[0]!.sourceTransaction = listing;
  expect(purchaseUnlock(tx, 0).toHex()).toBe(tx.inputs[0]!.unlockingScript!.toHex());
  const parsed = decodeListing(listing.outputs[0]!.lockingScript.toHex());
  expect(parsed.price).toBe(f.price); expect(parsed.payAddress).toBe(f.seller);
  expect(tx.outputs[0]!.satoshis).toBe(1);
  expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(f.buyer).toHex());
  expect(tx.outputs[1]!.satoshis).toBe(f.price);
  expect(tx.outputs[1]!.lockingScript.toHex()).toBe(parsed.payoutScript.toHex());
  expect(tx.outputs[2]!.satoshis).toBe(marketplaceFee(f.price));
  expect(tx.outputs[2]!.lockingScript.toHex()).toBe(new P2PKH().lock(GRYD_FUND).toHex());
  let total = 0;
  for (const [i, source] of [listing, funding].entries()) {
    const input = tx.inputs[i]!, output = source.outputs[input.sourceOutputIndex]!;
    expect(input.sourceTXID).toBe(source.id("hex")); total += output.satoshis!;
    const args = { sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex, sourceSatoshis: output.satoshis!, lockingScript: output.lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, j) => j !== i), inputIndex: i, unlockingScript: input.unlockingScript!, inputSequence: input.sequence!, outputs: tx.outputs, lockTime: tx.lockTime };
    expect(new Spend(args).validate()).toBe(true);
    const tampered = tx.outputs.map((o, j) => ({ ...o, satoshis: j === 1 ? o.satoshis! - 1 : o.satoshis }));
    expect(() => new Spend({ ...args, outputs: tampered }).validate()).toThrow();
  }
  expect(total - tx.outputs.reduce((sum, o) => sum + o.satoshis!, 0)).toBe(f.minerFee);
});

test("strict canonical legacy OrdLock parsing uses payAddress, not cancellation identity", () => {
  const parsed = decodeListing(listingScript().toHex());
  expect(parsed.price).toBe(1000); expect(parsed.payAddress).toBe(seller);
  expect(parsed.payAddress).not.toBe(cancel);
  for (const script of ["51" + listingScript().toHex(), listingScript().toHex() + "51", new P2PKH().lock(seller).toHex()]) expect(() => decodeListing(script)).toThrow();
  expect(marketplaceFee(1)).toBe(1); expect(marketplaceFee(1001)).toBe(26);
  expect(normalizeListingOutpoint("AA".repeat(32) + ".0")).toBe("aa".repeat(32) + "_0");
  for (const bad of [" " + "aa".repeat(32) + "_0", "aa".repeat(32) + "_01", "aa".repeat(32) + "_4294967296", "bad"]) expect(() => normalizeListingOutpoint(bad)).toThrow();
});
test("property identity is deterministic and separate from payment address", () => {
  const key = PrivateKey.fromHex("1".padStart(64, "0"));
  expect(propertyKey(key).toAddress()).not.toBe(key.toAddress());
  expect(propertyKey(key).toAddress()).toBe(propertyKey(key).toAddress());
});
test("no-broadcast produces decoded preview without signing, raw hex, close envelope or spend records", async () => {
  const h = harness();
  try {
    const result = await buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, noBroadcast: true, fetchFn: h.fetchFn, broadcast: async () => { throw new Error("Forbidden broadcast"); } });
    expect(result.mode).toBe("preview"); expect(result.price).toBe(1000); expect(result.marketplaceFee).toBe(25);
    expect(result.outputs[0]!.address).toBe(propertyKey(h.vault.key).toAddress());
    expect(result.outputs[0]!.satoshis).toBe(1);
    expect(result.outputs[1]!.address).toBe(seller); expect(result.outputs[2]!.address).toBe(GRYD_FUND);
    expect(JSON.stringify(result)).not.toMatch(/signature|rawTx|close_txid|unlockingScript/);
    expect(existsSync(join(h.root, "spends.jsonl"))).toBe(false);
    expect(inspectPaymentHold(h.root).blocked).toBe(false);
  } finally { h.clean(); }
});
test("atomic purchase validates scripts, guards accounting and signs close-out as the actual property recipient", async () => {
  const h = harness();
  try {
    const result = await buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, fetchFn: h.fetchFn, broadcast: h.broadcast });
    expect(result.mode).toBe("broadcast");
    const tx = Transaction.fromHex(h.raw);
    expect(tx.inputs[0]!.sourceTXID).toBe(h.listing.id("hex"));
    for (const [i, prev] of [h.listing, h.funding].entries()) {
      const input = tx.inputs[i]!;
      expect(new Spend({ sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex, sourceSatoshis: prev.outputs[0]!.satoshis!, lockingScript: prev.outputs[0]!.lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, j) => j !== i), inputIndex: i, unlockingScript: input.unlockingScript!, inputSequence: input.sequence!, outputs: tx.outputs, lockTime: tx.lockTime }).validate()).toBe(true);
    }
    expect(loadUsage(h.root).spentLifetime).toBe(1025);
    expect(loadUsage(h.root, new Date(), "brc181-bsv").spentLifetime).toBe(1025 + result.minerFee);
    expect(inspectPaymentHold(h.root).blocked).toBe(false);
    if (result.mode !== "broadcast") throw new Error("Expected broadcast result");
    expect(result.envelope.address).toBe(propertyKey(h.vault.key).toAddress());
    expect(result.envelope.payload).toMatchObject({ action: "agent.buy", method: "POST", path: "/api/v1/agents/agent%2Fa/listing/close", body: { close_txid: tx.id("hex") } });
    expect(readdirSync(join(h.root, "gryd-purchases"))).toEqual([`${tx.id("hex")}.json`]);
  } finally { h.clean(); }
});
test("chain triples, source bytes, price and script failures never broadcast", async () => {
  for (const bad of ["spent", "wrong-pos", "wrong-value", "wrong-txid", "funding-value", "price"]) {
    const h = harness();
    try {
      const lookup = `/script/${h.hash}/unspent`;
      if (bad === "spent") h.responses.set(lookup, []);
      if (bad === "wrong-pos") h.responses.set(lookup, [{ tx_hash: h.listing.id("hex"), tx_pos: 1, value: 1 }]);
      if (bad === "wrong-value") h.responses.set(lookup, [{ tx_hash: h.listing.id("hex"), tx_pos: 0, value: 2 }]);
      if (bad === "wrong-txid") h.responses.set(`/tx/${h.listing.id("hex")}/hex`, h.funding.toHex());
      if (bad === "funding-value") h.responses.set(`/address/${h.vault.address}/unspent`, [{ tx_hash: h.funding.id("hex"), tx_pos: 0, value: 99999 }]);
      await expect(buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: bad === "price" ? 999 : 1000, fetchFn: h.fetchFn, broadcast: h.broadcast })).rejects.toThrow();
      expect(h.raw).toBe(""); expect(inspectPaymentHold(h.root).blocked).toBe(false);
    } finally { h.clean(); }
  }
});
test("both local destinations and aggregate caps gate before signing", async () => {
  for (const patch of [{ allowlist: [seller] }, { allowlist: [GRYD_FUND] }, { maxSatsPerTx: 1000 }, { maxSatsPerDay: 1000 }, { maxSatsLifetime: 1000 }]) {
    const h = harness();
    try {
      const p = join(h.root, "policy.json"); writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }));
      await expect(buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, fetchFn: h.fetchFn, broadcast: h.broadcast })).rejects.toThrow();
      expect(h.raw).toBe(""); expect(inspectPaymentHold(h.root).blocked).toBe(false);
    } finally { h.clean(); }
  }
});
test("ambiguous broadcast keeps valid hold and does not print close-out or account spend", async () => {
  const h = harness();
  try {
    await expect(buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, fetchFn: h.fetchFn, broadcast: async () => { throw new Error("timeout"); } })).rejects.toThrow();
    expect(inspectPaymentHold(h.root)).toMatchObject({ blocked: true, pending: "valid" });
    expect(loadUsage(h.root).spentLifetime).toBe(0);
    const calls = h.calls.length;
    await expect(buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, fetchFn: h.fetchFn, broadcast: h.broadcast })).rejects.toThrow();
    expect(h.calls.length).toBe(calls);
  } finally { h.clean(); }
});
test("BRC-181 both destinations, aggregate price, actual miner fee and lifetime usage", async () => {
  const dests = [seller, GRYD_FUND].map(a => canonicalDest(new P2PKH().lock(a).toHex())!);
  for (const scenario of ["allow", "seller-missing", "fund-missing", "aggregate-cap", "fee-cap", "budget", "history", "corrupt"]) {
    const h = harness();
    try {
      const envelope = issuePolicyEnvelope(h.vault.key, { origin: "gryd-test", perTxCap: scenario === "aggregate-cap" ? 1000 : 100000,
        totalBudget: ["budget", "history"].includes(scenario) ? 2000 : 100000, maxFee: scenario === "fee-cap" ? 0 : 100000,
        purpose: "offline test", allowlist: scenario === "seller-missing" ? [dests[1]!] : scenario === "fund-missing" ? [dests[0]!] : dests, destCaps: [] });
      writeFileSync(join(h.root, "brc181.json"), scenario === "corrupt" ? "{}" : JSON.stringify(envelope));
      if (scenario === "history") writeFileSync(join(h.root, "spends.jsonl"), JSON.stringify({ amount: 1000, fee: 1000, asset: "bridge-bsv" }) + "\n");
      const call = buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, noBroadcast: true, fetchFn: h.fetchFn, broadcast: h.broadcast });
      if (scenario === "allow") expect((await call).mode).toBe("preview");
      else await expect(call).rejects.toThrow();
      expect(h.raw).toBe(""); expect(inspectPaymentHold(h.root).blocked).toBe(false);
    } finally { h.clean(); }
  }
});
test("CLI preview is real, offline-intercepted, human-only and packaged", () => {
  const h = harness();
  try {
    const mock = join(h.root, "preload.ts");
    writeFileSync(mock, `const responses = new Map(${JSON.stringify([...h.responses])}); globalThis.fetch = async (url, init) => { if ((init?.method ?? 'GET') !== 'GET') throw new Error('Network sends forbidden'); const key = String(url).replace('https://api.whatsonchain.com/v1/bsv/main', ''); if (!responses.has(key)) throw new Error('Unexpected network'); const body = responses.get(key); return new Response(typeof body === 'string' ? body : JSON.stringify(body)); };`);
    const run = (args: string[]) => Bun.spawnSync([process.execPath, "--preload", mock, "src/cli.ts", "agent-buy", ...args], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOGFOOD_WALLET_DIR: h.root } });
    const result = run([h.point, "1000", "--no-broadcast"]);
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout.toString()).mode).toBe("preview");
    for (const args of [[], [h.point, "1e3"], [h.point, "-1"], [h.point, "1000", "--wat"], [h.point, "1000", "--no-broadcast", "--no-broadcast"]]) {
      const bad = run(args); expect(bad.exitCode).not.toBe(0); expect(bad.stdout.toString()).toBe("");
    }
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(pkg.files).toContain("src/gryd-buy.ts"); expect(pkg.files).toContain("src/gryd-ordlock-constants.ts");
    expect(readFileSync(join(import.meta.dir, "mcp.ts"), "utf8")).not.toMatch(/gryd-buy|agent-buy|buyAgent/);
  } finally { h.clean(); }
});
test("default ARC transport is intercepted; no backend POST; txid mismatch retains hold", async () => {
  for (const mismatch of [false, true]) {
    const h = harness();
    try {
      let posts = 0;
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(String(url)).toBe("https://arc.gorillapool.io/v1/tx"); posts++;
          const tx = Transaction.fromHex(JSON.parse(String(init.body)).rawTx);
          return Response.json({ txid: mismatch ? "00".repeat(32) : tx.id("hex"), txStatus: "SEEN_ON_NETWORK" });
        }
        return h.fetchFn(url, init);
      }) as typeof fetch;
      const result = buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats: 1000, fetchFn });
      if (mismatch) {
        await expect(result).rejects.toThrow("Ambiguous broadcast");
        expect(inspectPaymentHold(h.root).blocked).toBe(true);
        expect(loadUsage(h.root).spentLifetime).toBe(0);
      } else expect((await result).mode).toBe("broadcast");
      expect(posts).toBe(1);
    } finally { h.clean(); }
  }
});

test("killfile and invalid human max reject without network", async () => {
  const h = harness();
  try {
    killVault(h.root);
    for (const maxPriceSats of [1000, 0, -1, NaN, 1.5, Infinity]) await expect(buyAgent({ root: h.root, listingOutpoint: h.point, maxPriceSats, fetchFn: h.fetchFn })).rejects.toThrow();
    expect(h.calls).toEqual([]);
  } finally { h.clean(); }
});
