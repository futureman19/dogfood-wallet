import { describe, expect, test } from "bun:test";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import { fundRequest } from "./fund-request";

describe("fundRequest", () => {
  test("builds a Yours/BRC-100 createAction payload to the vault P2PKH", () => {
    const address = PrivateKey.fromRandom().toAddress();
    const r = fundRequest({ address, sats: 10_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address).toBe(address);
    expect(r.sats).toBe(10_000);
    expect(r.lockingScriptHex).toBe(new P2PKH().lock(address).toHex());
    expect(r.createAction.description.length).toBeGreaterThanOrEqual(5);
    expect(r.createAction.description.length).toBeLessThanOrEqual(50);
    expect(r.createAction.outputs).toEqual([
      {
        lockingScript: r.lockingScriptHex,
        satoshis: 10_000,
        outputDescription: "Fund Dogfood vault",
      },
    ]);
    expect(r.createAction.options).toEqual({
      signAndProcess: true,
      acceptDelayedBroadcast: false,
      returnTXIDOnly: true,
    });
    expect(JSON.stringify(r)).not.toMatch(/\b5[HJK][1-9A-HJ-NP-Za-km-z]{50,}\b/);
  });

  test("rejects a bad address or amount", () => {
    const address = PrivateKey.fromRandom().toAddress();
    expect(fundRequest({ address: "not-p2pkh", sats: 1000 }).ok).toBe(false);
    expect(fundRequest({ address, sats: 0 }).ok).toBe(false);
    expect(fundRequest({ address, sats: 1.5 }).ok).toBe(false);
  });
});
