import { expect, test } from "bun:test";
import { evaluateGrydBuy, evaluateSend, parseGrydPolicy, usageFromLog } from "./policy";
import { parseStoredPolicy } from "./vault";

test("scoped usage counts only agent-buy amounts on the UTC day, including legacy rows", () => {
  const lines = [
    { t: "2026-10-17T23:30:00-02:00", kind: "agent-buy", amount: 100, fee: 50 },
    { t: "2026-10-18T02:00:00Z", kind: "agent-buy", amount: 200, asset: "bsv", fee: 70 },
    { t: "2026-10-17T23:59:59Z", kind: "agent-buy", amount: 9999 },
    { t: "2026-10-18T02:00:00Z", kind: "send", amount: 9999 },
  ].map(row => JSON.stringify(row));
  expect(usageFromLog(lines, new Date("2026-10-18T12:00:00Z"), "gryd").spentToday).toBe(300);
});

test("exact scoped cap boundaries, zero budget and kill override", () => {
  const budget = parseGrydPolicy({ maxPerTxSats: 100, maxPerDaySats: 200 })!;
  expect(evaluateGrydBuy(budget, false, 100, 100).ok).toBe(true);
  expect(evaluateGrydBuy(budget, false, 101, 0)).toMatchObject({ ok: false, code: "CAP" });
  expect(evaluateGrydBuy(budget, false, 100, 101)).toMatchObject({ ok: false, code: "DAY" });
  expect(evaluateGrydBuy(budget, true, 1, 0)).toMatchObject({ ok: false, code: "KILL" });
  expect(evaluateGrydBuy({ maxPerTxSats: 0, maxPerDaySats: 0 }, false, 1, 0).ok).toBe(false);
});

test("Gryd configuration never exempts an ordinary send from its allowlist", () => {
  const policy = parseStoredPolicy(JSON.stringify({ allowlist: [], maxSatsPerTx: 1000, gryd: { maxPerTxSats: 1000, maxPerDaySats: 2000 } }), false);
  expect(evaluateSend(policy, 1, "18Jc1Rq5Aw54UpCNLNvwoTLN4Uv5reTjCa")).toMatchObject({ ok: false, code: "ALLOWLIST" });
});
