import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { createMerchantApp, type MerchantConfig } from "./merchant";

// The replay ledger: merchant-side memory of every BSV payment already
// honored. In-memory is fine for one process lifetime, but a fly machine
// restart must not wipe it — the file store appends each reservation before
// broadcast and reloads on boot.

const dirs: string[] = [];
function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dogfood-replay-"));
  dirs.push(dir);
  return join(dir, name);
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("createMemoryReplayStore", () => {
  test("has() is false before reserve, true after; outpoints tracked too", async () => {
    const { createMemoryReplayStore } = await import("./replay-store");
    const store = createMemoryReplayStore();
    expect(store.has("aa", ["x:0"])).toBe(false);
    store.reserve("aa", ["x:0", "x:1"]);
    expect(store.has("aa", [])).toBe(true);
    expect(store.has("bb", ["x:1"])).toBe(true); // input reuse = double spend
    expect(store.has("bb", ["y:0"])).toBe(false);
  });
});

describe("createFileReplayStore", () => {
  test("reservations survive a new instance on the same path", async () => {
    const { createFileReplayStore } = await import("./replay-store");
    const path = tmpPath("replay.jsonl");
    createFileReplayStore(path).reserve("tx1", ["a:0"]);
    const reloaded = createFileReplayStore(path);
    expect(reloaded.has("tx1", [])).toBe(true);
    expect(reloaded.has("tx2", ["a:0"])).toBe(true);
    expect(reloaded.has("tx2", ["b:0"])).toBe(false);
  });

  test("accumulates across instances and tolerates a missing file", async () => {
    const { createFileReplayStore } = await import("./replay-store");
    const path = tmpPath(join("nested", "replay.jsonl"));
    const first = createFileReplayStore(path); // no file yet
    first.reserve("tx1", ["a:0"]);
    const second = createFileReplayStore(path);
    second.reserve("tx2", ["b:0"]);
    const third = createFileReplayStore(path);
    expect(third.has("tx1", [])).toBe(true);
    expect(third.has("tx2", [])).toBe(true);
  });
});

describe("merchant BSV replay persistence", () => {
  test("a restarted merchant rejects a replayed payment even when the chain still shows it unspent", async () => {
    const { createFileReplayStore } = await import("./replay-store");
    const key = PrivateKey.fromRandom();
    const payTo = PrivateKey.fromRandom().toAddress();
    const source = new Transaction();
    source.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(key.toAddress()) });
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: source, sourceTXID: source.id("hex"), sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) });
    tx.addOutput({ satoshis: 500, lockingScript: new P2PKH().lock(payTo) });
    await tx.sign();

    let broadcasts = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/tx/${source.id("hex")}/hex`)) return new Response(source.toHex());
      if (url.endsWith(`/address/${key.toAddress()}/unspent`)) {
        return Response.json([{ tx_hash: source.id("hex"), tx_pos: 0, value: 2000 }]);
      }
      if (url === "https://arc.gorillapool.io/v1/tx") {
        broadcasts += 1;
        return Response.json({ txid: tx.id("hex") });
      }
      throw new Error(`Unexpected network call: ${url}`);
    }) as typeof fetch;

    const base: MerchantConfig = {
      payTo: "0x1111111111111111111111111111111111111111",
      priceBaseUnits: 1000,
      resourcePath: "/v1/fortune",
      facilitatorUrl: "https://facilitator.invalid",
      network: "base-sepolia",
    };
    const path = tmpPath("merchant-replay.jsonl");
    const mkApp = () =>
      createMerchantApp({ ...base, bsvPayTo: payTo, fetchFn, replayStore: createFileReplayStore(path) });
    const pay = () => new Request("https://merchant.invalid/v1/fortune", { headers: { "X-BSV-PAYMENT": tx.toHex() } });

    const first = await mkApp()(pay());
    expect(first.status).toBe(200);
    expect(broadcasts).toBe(1);

    // Simulate a process restart: brand-new app, same ledger file, and the
    // chain mock STILL reports the input unspent (mempool lag after reboot).
    const replayed = await mkApp()(pay());
    expect(replayed.status).toBe(402);
    const body = (await replayed.json()) as { error?: string };
    expect(body.error ?? "").toContain("replay");
    expect(broadcasts).toBe(1); // no second broadcast, ever
  });
});
