import { describe, expect, test } from "bun:test";
import { evaluateEvmSend, usageFromLog, type EvmAssetPolicy } from "./policy";

const pocket: EvmAssetPolicy = {
  maxPerTx: 1_000_000, // 1.00 USDC
  maxPerDay: 5_000_000,
  maxLifetime: null,
  allowlist: ["0x209693bc6afc0c5328ba36faf03c18ef3122c5ea"],
};

describe("evaluateEvmSend", () => {
  test("missing pocket config refuses disabled", () => {
    const d = evaluateEvmSend(undefined, false, 1, "0x209693bc6afc0c5328ba36faf03c18ef3122c5ea");
    expect(d).toMatchObject({ ok: false, code: "DISABLED" });
  });

  test("allows an in-cap spend to an allowlisted payee (case-insensitive)", () => {
    const d = evaluateEvmSend(pocket, false, 500_000, "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA");
    expect(d.ok).toBe(true);
  });

  test("rejects over-cap, non-allowlisted, killfile, bad address, bad amount", () => {
    expect(evaluateEvmSend(pocket, false, 1_000_001, pocket.allowlist![0])).toMatchObject({ ok: false, code: "CAP" });
    expect(evaluateEvmSend(pocket, false, 1, "0x1111111111111111111111111111111111111111")).toMatchObject({
      ok: false,
      code: "ALLOWLIST",
    });
    expect(evaluateEvmSend(pocket, true, 1, pocket.allowlist![0])).toMatchObject({ ok: false, code: "KILL" });
    expect(evaluateEvmSend(pocket, false, 1, "not-an-address")).toMatchObject({ ok: false, code: "BAD_ADDRESS" });
    expect(evaluateEvmSend(pocket, false, 0, pocket.allowlist![0])).toMatchObject({ ok: false, code: "BAD_AMOUNT" });
  });

  test("day and lifetime caps use asset-scoped usage", () => {
    const usage = { spentToday: 4_900_000, spentLifetime: 0 };
    expect(evaluateEvmSend(pocket, false, 200_000, pocket.allowlist![0], usage)).toMatchObject({
      ok: false,
      code: "DAY",
    });
    expect(evaluateEvmSend(pocket, false, 100_000, pocket.allowlist![0], usage).ok).toBe(true);
  });

  test("null allowlist is unrestricted; empty allowlist denies all", () => {
    expect(evaluateEvmSend({ ...pocket, allowlist: null }, false, 1, "0x1111111111111111111111111111111111111111").ok).toBe(true);
    expect(evaluateEvmSend({ ...pocket, allowlist: [] }, false, 1, "0x1111111111111111111111111111111111111111")).toMatchObject({
      ok: false,
      code: "ALLOWLIST",
    });
  });
});

describe("usageFromLog asset scoping", () => {
  const day = new Date().toISOString().slice(0, 10);
  test("sums only the requested asset; missing asset counts as bsv", () => {
    const lines = [
      JSON.stringify({ t: `${day}T01:00:00Z`, amount: 100, kind: "send", asset: "usdc-base" }),
      JSON.stringify({ t: `${day}T02:00:00Z`, amount: 200, kind: "send", asset: "usdc-base" }),
      JSON.stringify({ t: `${day}T03:00:00Z`, amount: 500, kind: "send" }),
      JSON.stringify({ t: `${day}T04:00:00Z`, amount: 700, kind: "send", asset: "bsv" }),
    ];
    expect(usageFromLog(lines, new Date(), "usdc-base")).toEqual({ spentToday: 300, spentLifetime: 300 });
    expect(usageFromLog(lines, new Date(), "bsv")).toEqual({ spentToday: 1200, spentLifetime: 1200 });
  });
});
