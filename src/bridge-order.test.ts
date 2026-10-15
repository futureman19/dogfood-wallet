import { mockFetch } from "./test-support/fetch";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bridge from "./bridge";
import { inspectPaymentHold, withPaymentGuard } from "./payment-guard";
import { sendPayment } from "./send";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "bridge-order-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const pocket = "0x1111111111111111111111111111111111111111";
const payin = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const quote = { provider: "fixture", fromAsset: "bsv", toAsset: "usdc-base", fromAmountSats: 100_000, toAmount: 10_000 };
const order = { provider: "fixture", id: "order-1", depositAddress: payin, depositAmountSats: 100_000, payoutAddress: pocket, payoutAmount: 10_000, status: "waiting" };
function args(r: string, overrides: any = {}) {
  const provider = { name: "fixture", quote: async () => ({ ...quote }), create: async () => ({ ...order }), status: async () => { throw new Error("status must not run"); } };
  return { root: r, prepare: async () => ({ bridge: { maxSatsPerSwap: 200_000, maxSatsPerDay: 300_000 }, killfileOn: false, usage: { spentToday: 0, spentLifetime: 0 }, fromAmountSats: 100_000, ourPocket: pocket, providers: [provider], ...overrides }) };
}
const run = (opts: any) => bridge.executeRebalance(opts);

test("creates durable intent before POST and order before returning a persistent quarantine; never deposits", async () => {
  const r = root(); let creates = 0; let sends = 0;
  const a = args(r); const prepared = await a.prepare();
  prepared.providers[0].create = async () => {
    creates++;
    expect(inspectPaymentHold(r).blocked).toBe(true);
    expect(JSON.parse(readFileSync(join(r, "bridge.intent.json"), "utf8"))).toMatchObject({ provider: "fixture", payoutAddress: pocket, fromAmountSats: 100_000, expectedPayoutAmount: 10_000 });
    return { ...order, apiKey: "DO_NOT_PERSIST", response: "DO_NOT_PERSIST" };
  };
  await expect(run({ root: r, prepare: async () => prepared, send: async () => { sends++; } })).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  expect(creates).toBe(1); expect(sends).toBe(0);
  expect(inspectPaymentHold(r)).toMatchObject({ blocked: true, pending: "valid" });
  const saved = readFileSync(join(r, "bridge.order.json"), "utf8");
  expect(JSON.parse(saved)).toMatchObject({ orderId: "order-1", depositAddress: payin, payoutAddress: pocket });
  expect(saved).not.toContain("DO_NOT_PERSIST");
  expect(readdirSync(r)).not.toContain("spends.jsonl");
  await expect(run({ root: r, prepare: async () => { throw new Error("must not read"); } })).rejects.toMatchObject({ code: "PAYMENT_HELD" });
  expect(await sendPayment({ root: r, to: payin, amount: 1 })).toMatchObject({ ok: false, code: "PAYMENT_HELD" });
});

test("existing send guard excludes bridge before reads and network", async () => {
  const r = root();
  await withPaymentGuard(r, "send", async () => {
    await expect(run({ root: r, prepare: async () => { throw new Error("read reached"); } })).rejects.toMatchObject({ code: "PAYMENT_HELD" });
  });
});

for (const [overrides, code] of [
  [{ bridge: undefined }, "DISABLED"], [{ killfileOn: true }, "KILL"],
  [{ fromAmountSats: 200_001 }, "CAP"], [{ usage: { spentToday: 250_000, spentLifetime: 0 } }, "DAY"],
] as const) test(`known pre-create policy refusal ${code} releases without network`, async () => {
  const r = root(); let network = 0;
  await expect(run(args(r, { ...overrides, providers: [{ name: "fixture", quote: async () => { network++; throw new Error(); } }] }))).rejects.toMatchObject({ code });
  expect(network).toBe(0); expect(inspectPaymentHold(r).blocked).toBe(false);
});

for (const q of [{ ...quote, toAmount: NaN }, { ...quote, fromAmountSats: 1 }, { ...quote, provider: "other" }, { ...quote, toAsset: "wrong" }]) test("untrusted quote is refused before create and releases", async () => {
  const r = root(); let creates = 0;
  await expect(run(args(r, { providers: [{ name: "fixture", quote: async () => q, create: async () => { creates++; return order; } }] }))).rejects.toMatchObject({ code: "NO_ROUTE" });
  expect(creates).toBe(0); expect(inspectPaymentHold(r).blocked).toBe(false);
});

for (const bad of [{ ...order, payoutAddress: "0x2222222222222222222222222222222222222222" }, { ...order, depositAddress: "bad" }, { ...order, depositAmountSats: 1 }, { ...order, payoutAmount: Infinity }, { ...order, id: "undefined" }, null]) test("invalid created order retains durable pre-create quarantine without depositing", async () => {
  const r = root();
  await expect(run(args(r, { providers: [{ name: "fixture", quote: async () => quote, create: async () => bad }] }))).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  expect(inspectPaymentHold(r).blocked).toBe(true);
  expect(readdirSync(r)).not.toContain("spends.jsonl");
});

test("ambiguous create timeout is sanitized, durable, and never automatically retried", async () => {
  const r = root(); let creates = 0;
  const a = args(r, { providers: [{ name: "fixture", quote: async () => quote, create: async () => { creates++; throw new Error("SECRET_PROVIDER_BODY"); } }] });
  try { await run(a); throw new Error("expected failure"); } catch (e: any) { expect(e.code).toBe("BRIDGE_ORDER_HELD"); expect(e.message).not.toContain("SECRET"); }
  await expect(run(a)).rejects.toMatchObject({ code: "PAYMENT_HELD" });
  expect(creates).toBe(1); expect(readdirSync(r)).toContain("bridge.intent.json");
});

test("order persistence failure retains pre-create intent and zero accounting", async () => {
  const r = root();
  const a = args(r, { providers: [{ name: "fixture", quote: async () => quote, create: async () => { mkdirSync(join(r, "bridge.order.json")); return order; } }] });
  await expect(run(a)).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  expect(inspectPaymentHold(r).blocked).toBe(true);
  expect(readdirSync(r)).not.toContain("spends.jsonl");
});

for (const file of ["bridge.intent.json", "bridge.order.json"]) test(`orphan/corrupt ${file} blocks before prepare`, async () => {
  const r = root(); writeFileSync(join(r, file), "corrupt");
  await expect(run({ root: r, prepare: async () => { throw new Error("must not read"); } })).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
});

test("read-only local bridge status never records an inferred arrival or clears quarantine", async () => {
  const r = root(); await expect(run(args(r))).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  const before = readdirSync(r).map(f => [f, readFileSync(join(r, f), "utf8")]);
  for (let i = 0; i < 2; i++) expect((bridge as any).inspectBridgeOrder(r)).toMatchObject({ state: "order-recorded", deposit: "not-submitted-by-this-path", arrival: "unverified", orderId: "order-1" });
  expect(readdirSync(r).map(f => [f, readFileSync(join(r, f), "utf8")])).toEqual(before);
});

test("legacy spend logs remain untouched and require manual reconciliation", async () => {
  const r = root(); const legacy = '{"kind":"bridge-out","orderId":"old"}\n'; writeFileSync(join(r, "spends.jsonl"), legacy);
  await expect(run(args(r))).rejects.toMatchObject({ code: "BRIDGE_HISTORY" });
  expect(readFileSync(join(r, "spends.jsonl"), "utf8")).toBe(legacy);
});

test("CLI bridge has no raw send or arrival writer and stays off MCP", () => {
  const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  const section = cli.slice(cli.indexOf('case "bridge-rebalance"'), cli.indexOf('case "merchant"'));
  expect(section).not.toContain("sendRaw"); expect(section).not.toContain("recordFinishedArrival");
  expect(section).toContain("fundBridge");
  const mcp = readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
  expect(mcp).not.toContain('"bridge-rebalance"');
});

for (const [name, make] of [["changenow", async (fetchFn: typeof fetch) => (await import("./bridge-changenow")).changenowProvider({ apiKey: "fixture-only", fetchFn })], ["exolix", async (fetchFn: typeof fetch) => (await import("./bridge-exolix")).exolixProvider({ fetchFn })]] as const) {
  test(`${name} missing create evidence is not replaced by request/quote values`, async () => {
    const provider = await make(mockFetch((async () => new Response(JSON.stringify({ id: "known-order", payinAddress: payin, depositAddress: payin })))));
    await expect(provider.create({ quote: { ...quote, provider: name } as any, payoutAddress: pocket })).rejects.toMatchObject({candidateOrderId: "known-order"});
  });
  test(`${name} provider errors omit response bodies`, async () => {
    const provider = await make(mockFetch((async () => new Response(JSON.stringify({ message: "PRIVATE_RESPONSE" }), { status: 400 }))));
    try { await provider.create({ quote: { ...quote, provider: name } as any, payoutAddress: pocket }); throw new Error("expected rejection"); }
    catch (e: any) { expect(e.message).not.toContain("PRIVATE_RESPONSE"); }
  });
}

test("before-create intent persistence failure makes zero provider POSTs", async () => {
  const r = root(); let creates = 0;
  const a = args(r, { providers: [{ name: "fixture", quote: async () => {
    mkdirSync(join(r, "bridge.intent.json")); return quote;
  }, create: async () => { creates++; return order; } }] });
  await expect(run(a)).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  expect(creates).toBe(0); expect(inspectPaymentHold(r).blocked).toBe(true);
});

function childEnv(r: string) {
  return { PATH: process.env.PATH!, SystemRoot: process.env.SystemRoot!, TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir(), DOGFOOD_WALLET_DIR: r };
}
const moduleUrl = new URL("./bridge.ts", import.meta.url).href;
function child(r: string, code: string) {
  return Bun.spawnSync([process.execPath, "-e", code], { env: childEnv(r), stdout: "pipe", stderr: "pipe" });
}
test("cross-process send lock rejects real CLI bridge before vault reads or network", async () => {
  const r = root();
  await withPaymentGuard(r, "send", async () => {
    const result = Bun.spawnSync([process.execPath, new URL("./cli.ts", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""), "bridge-rebalance", "100000"], { env: childEnv(r), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("payment is active or unresolved");
    expect(result.stderr.toString()).not.toContain("init");
  });
});

test("process death during order creation preserves quarantine across restart and blocks send", async () => {
  const r = root();
  const result = child(r, `import { executeRebalance } from ${JSON.stringify(moduleUrl)};
    await executeRebalance({ root: ${JSON.stringify(r)}, prepare: async () => ({
      bridge: { maxSatsPerSwap: 200000, maxSatsPerDay: 300000 }, killfileOn: false,
      usage: { spentToday: 0, spentLifetime: 0 }, fromAmountSats: 100000,
      ourPocket: ${JSON.stringify(pocket)}, providers: [{ name: "fixture", quote: async () => (${JSON.stringify(quote)}), create: async () => { process.exit(77); } }]
    }) });`);
  expect(result.exitCode).toBe(77);
  expect((bridge as any).inspectBridgeOrder(r).state).toBe("creation-unresolved");
  await expect(run(args(r))).rejects.toMatchObject({ code: "PAYMENT_HELD" });
  const sendUrl = new URL("./send.ts", import.meta.url).href;
  const contender = child(r, `import {sendPayment} from ${JSON.stringify(sendUrl)}; console.log(JSON.stringify(await sendPayment({root:${JSON.stringify(r)},to:${JSON.stringify(payin)},amount:1})));`);
  expect(contender.exitCode).toBe(0); expect(contender.stdout.toString()).toContain("PAYMENT_HELD");
});

for (const data of ["{broken", "null", "[]"]) test("corrupt history never silently bypasses bridge reconciliation", async () => {
  const r = root(); writeFileSync(join(r, "spends.jsonl"), data);
  await expect(run(args(r))).rejects.toMatchObject({ code: "BRIDGE_HISTORY" });
  expect(readFileSync(join(r, "spends.jsonl"), "utf8")).toBe(data);
});

for (const depositAddress of ["1BoatSLRHtKNngkdXEeobR76b53LETtpyU", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"]) test("payin must be checksum-valid mainnet P2PKH, not merely address-shaped", async () => {
  const r = root();
  await expect(run(args(r, { providers: [{ name: "fixture", quote: async () => quote, create: async () => ({ ...order, depositAddress }) }] }))).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  const saved = JSON.parse(readFileSync(join(r, "bridge.order.json"), "utf8"));
  expect(saved.validated).toBe(false); expect(saved.orderId).toBe("order-1");
  expect(saved).not.toHaveProperty("depositAddress");
  expect((bridge as any).inspectBridgeOrder(r).state).toBe("invalid");
});

for (const name of ["changenow", "exolix"]) test(`${name} preserves order ID when create lacks payin evidence`, async () => {
  const fetchFn = mockFetch((async () => new Response(JSON.stringify({ id: "candidate-order" }))));
  const provider = name === "changenow" ? (await import("./bridge-changenow")).changenowProvider({ apiKey: "fixture-only", fetchFn }) : (await import("./bridge-exolix")).exolixProvider({ fetchFn });
  const r = root();
  provider.quote = async () => ({ ...quote, provider: name }) as any;
  await expect(run(args(r, { providers: [provider] }))).rejects.toMatchObject({ code: "BRIDGE_ORDER_HELD" });
  expect(JSON.parse(readFileSync(join(r, "bridge.order.json"), "utf8"))).toMatchObject({ orderId: "candidate-order", validated: false });
});

test("real CLI holds after unavailable funding source; offline status never decrypts or accounts", async () => {
  const r = root();
  const { initVault, loadVault } = await import("./vault");
  const { deriveEvmAddress } = await import("./evm");
  initVault(r);
  const expectedPocket = deriveEvmAddress(loadVault(r).key);
  const policyPath = join(r, "policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  policy.bridge = { maxSatsPerSwap: 200_000, maxSatsPerDay: 300_000 };
  writeFileSync(policyPath, JSON.stringify(policy));
  const preload = join(r, "network-fixture.ts");
  writeFileSync(preload, `globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://exolix.com/api/v2/rate?")) return Response.json({toAmount: 0.01});
    if (url === "https://exolix.com/api/v2/transactions" && init?.method === "POST") {
      const request = JSON.parse(init.body);
      if (request.withdrawalAddress !== ${JSON.stringify(expectedPocket)}) throw new Error("wrong own payout");
      return Response.json({id:"cli-order", depositAddress:${JSON.stringify(payin)}, withdrawalAddress:request.withdrawalAddress, amount:request.amount, amountTo:0.01,
      coinFrom:{coinCode:"BSV",network:"BSV",contract:null},coinTo:{coinCode:"USDC",network:"BASE",contract:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},status:"wait",hashIn:{hash:null},hashOut:{hash:null}});
    }
    if (url === "https://mainnet.base.org") { const q=JSON.parse(init.body); return Response.json({jsonrpc:"2.0",id:q.id,result:q.method==="eth_chainId"?"0x2105":{number:"0x63",hash:"0x"+"c".repeat(64)}}); }
    throw new Error("Unexpected network; funding must remain disabled");
  };`);
  const cli = new URL("./cli.ts", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  const first = Bun.spawnSync([process.execPath, "--preload", preload, cli, "bridge-rebalance", "100000"], { env: childEnv(r), stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(1); expect(first.stderr.toString()).toContain("Bridge exposure quarantined");
  const {inspectFundedBridge} = await import("./bridge-funded");
  expect(inspectFundedBridge(r)[0]).toMatchObject({state:"order-recorded",orderId:"cli-order"});
  expect(readFileSync(join(r,"spends.jsonl"),"utf8")).toBe("");
  // Make vault policy unreadable to prove local status does not load it.
  writeFileSync(policyPath, "broken");
  const evidencePath = join(r,"bridge-records",(inspectFundedBridge(r)[0] as any).intentId,"order.json");
  const before = readFileSync(evidencePath, "utf8");
  const status = Bun.spawnSync([process.execPath, cli, "bridge-status", "cli-order"], { env: childEnv(r), stdout: "pipe", stderr: "pipe" });
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(status.stdout.toString())[0]).toMatchObject({ state: "order-recorded",orderId:"cli-order" });
  expect(readFileSync(evidencePath, "utf8")).toBe(before);
  const retry = Bun.spawnSync([process.execPath, cli, "bridge-rebalance", "100000"], { env: childEnv(r), stdout: "pipe", stderr: "pipe" });
  expect(retry.exitCode).toBe(1); expect(retry.stderr.toString()).toContain("payment is active or unresolved");
});

for (const name of ["changenow", "exolix"]) test(`${name} does not coerce boolean IDs or amounts into valid evidence`, async () => {
  const fetchFn = mockFetch((async () => Response.json({ id: true, payinAddress: payin, depositAddress: payin,
    payoutAddress: pocket, withdrawalAddress: pocket, fromAmount: 0.001000001, amount: 0.001000001, toAmount: true })));
  const provider = name === "changenow" ? (await import("./bridge-changenow")).changenowProvider({ apiKey: "fixture-only", fetchFn }) : (await import("./bridge-exolix")).exolixProvider({ fetchFn });
  await expect(provider.create({ quote: { ...quote, provider: name } as any, payoutAddress: pocket })).rejects.toThrow();
});

for (const name of ["changenow", "exolix"]) test(`${name} refuses boolean quote amounts`, async () => {
  const fetchFn = mockFetch((async () => Response.json({ toAmount: true })));
  const provider = name === "changenow" ? (await import("./bridge-changenow")).changenowProvider({ apiKey: "fixture-only", fetchFn }) : (await import("./bridge-exolix")).exolixProvider({ fetchFn });
  await expect(provider.quote({ fromAmountSats: 100_000 })).rejects.toThrow();
});
