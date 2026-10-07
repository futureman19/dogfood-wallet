import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import { fundRequest as cliFundRequest } from "../../src/fund-request";
import { fundRequest, payVaultWithWallet, walletCreateActionArgs } from "./payVault.js";

describe("Yours fund button payload", () => {
  test("maps fundRequest into WalletInterface.createAction args", () => {
    const address = PrivateKey.fromRandom().toAddress();
    const request = fundRequest({ address, sats: 10_000 });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(walletCreateActionArgs(request)).toEqual(request.createAction);
    expect(request).toEqual(cliFundRequest({ address, sats: 10_000 }));
  });

  test("refuses a failed fundRequest", () => {
    const request = fundRequest({ address: "nope", sats: 1000 });
    expect(request.ok).toBe(false);
    expect(() => walletCreateActionArgs(request)).toThrow(/REJECTED/);
  });

  test("payVaultWithWallet passes createAction args and returns txid", async () => {
    const address = PrivateKey.fromRandom().toAddress();
    const request = fundRequest({ address, sats: 1000 });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const calls = [];
    const result = await payVaultWithWallet(
      {
        createAction: async (args) => {
          calls.push(args);
          return { txid: "aa".repeat(32) };
        },
      },
      { address, sats: 1000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.txid).toHaveLength(64);
    expect(calls).toEqual([request.createAction]);
  });
});
