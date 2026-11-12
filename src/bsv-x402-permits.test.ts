import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, Script, Transaction } from "@bsv/sdk";
import { settleBsvX402 } from "./bsv-x402";
import { mockFetch } from "./test-support/fetch";
import { initVault, loadVault, vaultPaths } from "./vault";
import { fileRequest, approveRequest } from "./requests";
import { findPermit, commitPermit, releasePermit, spendPermit, listPermits } from "./permits";
import { payX402 } from "./x402-pay";
import type { Policy } from "./policy";
import { issuePolicyEnvelope } from "./policy-issue";

const payTo = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";
const other = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const url = "https://merchant.example/permit";

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "dogfood-x402-permits-"));
  try { await run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  initVault(root);
  const vault = loadVault(root);
  const { request } = fileRequest(root, { kind: "permit-send", to: payTo, amount: 500 });
  approveRequest(root, request.id);
  const coin = new Transaction();
  coin.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
  coin.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(vault.address) });
  const state = { empty: false, badUtxo: false, badReceipt: false, reject: false, timeout: false, calls: 0, payments: 0, finds: 0, releases: 0 };
  const requirement = { scheme: "bsv-direct", network: "bsv-main", satoshis: 500, payTo };
  const rows: Record<string, unknown>[] = [];
  const fetchFn = mockFetch(async (input, init) => {
    state.calls++;
    const u = String(input);
    if (u === url) {
      const hex = new Headers(init?.headers).get("X-BSV-PAYMENT");
      if (!hex) return Response.json({ accepts: [requirement] }, { status: 402 });
      state.payments++;
      expect(listPermits(root)[0]!.status).not.toBe("spent");
      if (state.timeout) throw new Error("merchant timeout");
      return new Response("paid", { status: state.reject ? 500 : 200, headers: {
        "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, network: "bsv-main", transaction: state.badReceipt ? "a".repeat(64) : Transaction.fromHex(hex).id("hex") })).toString("base64"),
      } });
    }
    const woc = "https://api.whatsonchain.com/v1/bsv/main";
    if (u === `${woc}/address/${vault.address}/unspent`) return Response.json(state.empty ? [] : [{ tx_hash: coin.id("hex"), tx_pos: 0, value: state.badUtxo ? 1999 : 2000 }]);
    if (u === `${woc}/tx/${coin.id("hex")}/hex`) return new Response(coin.toHex());
    throw new Error(`Unexpected network: ${u}`);
  });
  const permitHooks = {
    find: (to: string, amount: number) => { state.finds++; return findPermit(root, to, amount)?.id; },
    commit: (id: string) => { commitPermit(root, id); },
    release: (id: string) => { state.releases++; releasePermit(root, id); },
    spend: (id: string, txid: string) => { spendPermit(root, id, txid); },
  };
  const opts = { url, key: vault.key, from: vault.address, policy: vault.policy, usage: { spentToday: 0, spentLifetime: 0 }, fetchFn, permitHooks, onSpend: (row: Record<string, unknown>) => { rows.push(row); } };
  return { root, state, requirement, rows, opts, permit: () => listPermits(root)[0]! };
}

test("empty allowlist permit settles exactly once, stamps txid and logs", () => fixture(async f => {
  const r = await settleBsvX402(f.opts);
  expect(f.permit()).toMatchObject({ status: "spent", txid: r.txid });
  expect(f.rows).toEqual([expect.objectContaining({ txid: r.txid, amount: 500, to: payTo, asset: "bsv" })]);
  await expect(settleBsvX402(f.opts)).rejects.toMatchObject({ code: "ALLOWLIST" });
  expect(f.state.payments).toBe(1);
}));

for (const [name, change] of [
  ["CAP", { maxSatsPerTx: 499 }],
  ["DAY", { maxSatsPerDay: 499 }],
  ["LIFETIME", { maxSatsLifetime: 499 }],
] satisfies [string, Partial<Policy>][]) {
  test(`permit waives ${name}`, () => fixture(async f => {
    const r = await settleBsvX402({ ...f.opts, policy: { ...f.opts.policy, allowlist: [payTo], ...change } });
    expect(f.permit()).toMatchObject({ status: "spent", txid: r.txid });
  }));
}

test("policy passing payment never consults or consumes permit", () => fixture(async f => {
  await settleBsvX402({ ...f.opts, policy: { ...f.opts.policy, allowlist: [payTo] } });
  expect(f.state.finds).toBe(0);
  expect(f.permit().status).toBe("unspent");
}));

test("KILL leaves permit untouched and only reads challenge", () => fixture(async f => {
  await expect(settleBsvX402({ ...f.opts, policy: { ...f.opts.policy, killfileOn: true } })).rejects.toMatchObject({ code: "KILL" });
  expect(f.state.calls).toBe(1);
  expect(f.state.finds).toBe(0);
  expect(f.permit().status).toBe("unspent");
}));

test("INSUFFICIENT releases for funded retry", () => fixture(async f => {
  f.state.empty = true;
  await expect(settleBsvX402(f.opts)).rejects.toMatchObject({ code: "INSUFFICIENT" });
  expect(f.permit().status).toBe("unspent");
  expect(f.state.releases).toBe(1);
  f.state.empty = false;
  const r = await settleBsvX402(f.opts);
  expect(f.permit()).toMatchObject({ status: "spent", txid: r.txid });
}));

for (const change of [{ satoshis: 501 }, { payTo: other }]) {
  test(`exact match rejects ${JSON.stringify(change)}`, () => fixture(async f => {
    Object.assign(f.requirement, change);
    await expect(settleBsvX402(f.opts)).rejects.toMatchObject({ code: "ALLOWLIST" });
    expect(f.permit().status).toBe("unspent");
    expect(f.state.calls).toBe(1);
  }));
}

for (const mode of ["badReceipt", "reject", "timeout"] as const) {
  test(`after submission ${mode} retains committed permit`, () => fixture(async f => {
    f.state[mode] = true;
    await expect(settleBsvX402(f.opts)).rejects.toThrow(mode === "timeout" ? "merchant timeout" : "invalid BSV settlement receipt");
    expect(f.permit().status).toBe("committed");
    expect(f.permit().txid).toBeUndefined();
    expect(f.state.releases).toBe(0);
    expect(f.state.payments).toBe(1);
    expect(f.rows).toEqual([]);
  }));
}

test("no hooks preserves original policy denial", () => fixture(async f => {
  await expect(settleBsvX402({ ...f.opts, permitHooks: undefined })).rejects.toMatchObject({ code: "ALLOWLIST" });
  expect(f.state.finds).toBe(0);
  expect(f.state.calls).toBe(1);
  expect(f.permit().status).toBe("unspent");
}));

test("BAD_UTXO releases before commitment", () => fixture(async f => {
  f.state.badUtxo = true;
  await expect(settleBsvX402(f.opts)).rejects.toMatchObject({ code: "BAD_UTXO" });
  expect(f.permit().status).toBe("unspent");
  expect(f.state.releases).toBe(1);
  expect(f.state.payments).toBe(0);
}));

test("beforeSign rejection releases committed permit", () => fixture(async f => {
  await expect(settleBsvX402({ ...f.opts, beforeSign: () => {
    expect(f.permit().status).toBe("committed");
    throw new Error("reservation refused");
  } })).rejects.toThrow("reservation refused");
  expect(f.permit().status).toBe("unspent");
  expect(f.state.releases).toBe(1);
  expect(f.state.payments).toBe(0);
}));

test("signed BRC-181 rejection cannot be waived and releases permit", () => fixture(async f => {
  const policyEnvelope = issuePolicyEnvelope(f.opts.key, {
    origin: "permit-test", purpose: "test", perTxCap: 499, totalBudget: 1000,
    maxFee: 1000, destCaps: [], allowlist: [],
  });
  await expect(settleBsvX402({ ...f.opts, policyEnvelope, origin: "permit-test" })).rejects.toThrow("BRC-181");
  expect(f.permit().status).toBe("unspent");
  expect(f.state.releases).toBe(1);
  expect(f.state.calls).toBe(1);
}));

test("envelope loading failure cannot be waived and releases permit", () => fixture(async f => {
  await expect(settleBsvX402({ ...f.opts, get policyEnvelope(): never { throw new Error("invalid envelope"); } })).rejects.toThrow("invalid envelope");
  expect(f.permit().status).toBe("unspent");
  expect(f.state.releases).toBe(1);
  expect(f.state.calls).toBe(1);
}));

for (const change of [{ satoshis: 0 }, { payTo: "bad" }]) {
  test(`malformed challenge never consults permit ${JSON.stringify(change)}`, () => fixture(async f => {
    Object.assign(f.requirement, change);
    await expect(settleBsvX402(f.opts)).rejects.toMatchObject({ code: "satoshis" in change ? "BAD_AMOUNT" : "BAD_ADDRESS" });
    expect(f.state.finds).toBe(0);
    expect(f.permit().status).toBe("unspent");
  }));
}

test("payX402 wires real permits and guarded spend accounting", () => fixture(async f => {
  const mocked = spyOn(globalThis, "fetch").mockImplementation(f.opts.fetchFn);
  try {
    const r = await payX402(f.root, url);
    if (!("txid" in r)) throw new Error("Expected BSV settlement");
    expect(f.permit()).toMatchObject({ status: "spent", txid: r.txid });
    const rows = readFileSync(vaultPaths(f.root).log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual([expect.objectContaining({ asset: "bsv", amount: 500, to: payTo, txid: r.txid })]);
    await expect(payX402(f.root, url)).rejects.toMatchObject({ code: "ALLOWLIST" });
    expect(f.state.payments).toBe(1);
  } finally { mocked.mockRestore(); }
}));
