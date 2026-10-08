import { expect, test, spyOn } from "bun:test";
import { PrivateKey, P2PKH, Transaction, Spend } from "@bsv/sdk";
import { pickBsvDirect, settleBsvX402 } from "./bsv-x402";
import { createMerchantApp } from "./merchant";
import type { Policy } from "./policy";

const key = PrivateKey.fromHex("1".padStart(64, "0"));
const from = key.toAddress();
const payTo = PrivateKey.fromHex("2".padStart(64, "0")).toAddress();
const url = "https://merchant.example/v1/fortune";
const policy: Policy = { maxSatsPerTx: 1000, maxSatsPerDay: 2000, maxSatsLifetime: null, allowlist: [payTo], killfileOn: false };
const usage = { spentToday: 0, spentLifetime: 0 };
const requirement = { scheme: "bsv-direct", network: "bsv-main", satoshis: 500, payTo };
const source = new Transaction();
source.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(from) });
const sourceId = source.id("hex");
const utxos = [{ tx_hash: sourceId, tx_pos: 0, value: 2000 }];
const woc = "https://api.whatsonchain.com/v1/bsv/main";
function chain(input: string): Response {
  if (input === `${woc}/address/${from}/unspent`) return Response.json(utxos);
  if (input === `${woc}/tx/${sourceId}/hex`) return new Response(source.toHex());
  throw new Error(`Unexpected network: ${input}`);
}
const opts = { url, key, from, policy, usage };

test("pickBsvDirect extracts only mainnet direct BSV", () => {
  expect(pickBsvDirect({ accepts: [null, {}, requirement] })).toEqual(requirement);
  for (const body of [null, {}, { accepts: [] }, { accepts: [{ ...requirement, network: "bsv-test" }] }]) {
    expect(pickBsvDirect(body)).toBeNull();
  }
});

for (const [code, change, spent] of [
  ["CAP", { maxSatsPerTx: 499 }, usage],
  ["KILL", { killfileOn: true }, usage],
  ["ALLOWLIST", { allowlist: [] }, usage],
  ["DAY", {}, { spentToday: 1600, spentLifetime: 1600 }],
  ["LIFETIME", { maxSatsLifetime: 499 }, usage],
] as const) {
  test(`${code} refuses before building a transaction or fetching chain data`, async () => {
    let calls = 0;
    const spends: unknown[] = [];
    const build = spyOn(Transaction.prototype, "addInput");
    try {
      const fetchFn = (async () => { calls++; return Response.json({ accepts: [requirement] }, { status: 402 }); }) as typeof fetch;
      await expect(settleBsvX402({ ...opts, policy: { ...policy, ...change }, usage: spent, fetchFn, onSpend: r => spends.push(r) })).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
      expect(build).not.toHaveBeenCalled();
      expect(spends).toEqual([]);
    } finally { build.mockRestore(); }
  });
}

test("no bsv-direct entry is UNSUPPORTED without chain access", async () => {
  let calls = 0;
  await expect(settleBsvX402({ ...opts, fetchFn: (async () => {
    calls++; return Response.json({ accepts: [{ scheme: "exact", network: "base" }] }, { status: 402 });
  }) as typeof fetch })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(calls).toBe(1);
});

for (const satoshis of [0, -1, 1.5, "500", Number.MAX_SAFE_INTEGER + 1]) {
  test(`malformed BSV price ${satoshis} refuses rather than falling through`, async () => {
    await expect(settleBsvX402({ ...opts, fetchFn: (async () => Response.json({ accepts: [{ ...requirement, satoshis }] }, { status: 402 })) as typeof fetch })).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });
}

test("real client pays real merchant: signed tx conserves value, 200, receipt, BSV spend row", async () => {
  const broadcasts: Transaction[] = [];
  const chainFetch = (async (input, init) => {
    if (String(input) === "https://arc.gorillapool.io/v1/tx") {
      const tx = Transaction.fromHex(JSON.parse(String(init?.body)).rawTx);
      broadcasts.push(tx);
      return Response.json({ txid: tx.id("hex") });
    }
    return chain(String(input));
  }) as typeof fetch;
  const app = createMerchantApp({ payTo: "0x" + "42".repeat(20), priceBaseUnits: 1000, resourcePath: "/v1/fortune", network: "base", facilitatorUrl: "https://forbidden.example", bsvPayTo: payTo, bsvSatoshis: 500, fetchFn: chainFetch, facilitatorFetch: (async () => { throw new Error("USDC must not settle"); }) as typeof fetch });
  const statuses: number[] = [];
  const fetchFn = (async (input, init) => {
    if (String(input) !== url) return chain(String(input));
    const res = await app(new Request(url, init)); statuses.push(res.status); return res;
  }) as typeof fetch;
  const spends: Record<string, unknown>[] = [];
  const result = await settleBsvX402({ ...opts, fetchFn, onSpend: r => spends.push(r) });
  expect(statuses).toEqual([402, 200]);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.body).fortune).toBeString();
  expect(broadcasts).toHaveLength(1);
  const tx = broadcasts[0];
  const paid = tx.outputs.filter(o => o.lockingScript.toHex() === new P2PKH().lock(payTo).toHex()).reduce((s, o) => s + o.satoshis!, 0);
  expect(paid).toBeGreaterThanOrEqual(500);
  expect(tx.inputs[0].unlockingScript!.toHex().length).toBeGreaterThan(0);
  expect(tx.outputs.reduce((s, o) => s + o.satoshis!, 0) + result.fee).toBe(2000);
  // Verify the real signature without recursively verifying the synthetic funding history.
  expect(new Spend({ sourceTXID: sourceId, sourceOutputIndex: 0, sourceSatoshis: 2000,
    lockingScript: source.outputs[0].lockingScript, transactionVersion: tx.version,
    otherInputs: [], outputs: tx.outputs, inputIndex: 0, unlockingScript: tx.inputs[0].unlockingScript!,
    inputSequence: tx.inputs[0].sequence!, lockTime: tx.lockTime }).validate()).toBe(true);
  expect(spends).toHaveLength(1);
  expect(spends[0]).toMatchObject({ kind: "send", asset: "bsv", amount: 500, to: payTo, txid: tx.id("hex"), resource: url });
});

for (const receipt of [null, "garbage", { success: false }, { success: true, network: "base", transaction: "a".repeat(64) }, { success: true, network: "bsv-main", transaction: "a".repeat(64) }]) {
  test(`missing/invalid settlement receipt is fail-closed: ${JSON.stringify(receipt)}`, async () => {
    const spends: unknown[] = [];
    const fetchFn = (async (input, init) => {
      if (String(input) !== url) return chain(String(input));
      if (!init?.headers) return Response.json({ accepts: [requirement] }, { status: 402 });
      return new Response("paid", { headers: receipt === null ? {} : { "X-PAYMENT-RESPONSE": typeof receipt === "string" ? receipt : Buffer.from(JSON.stringify(receipt)).toString("base64") } });
    }) as typeof fetch;
    await expect(settleBsvX402({ ...opts, fetchFn, onSpend: r => spends.push(r) })).rejects.toMatchObject({ code: "SETTLE_FAILED" });
    expect(spends).toEqual([]);
  });
}
