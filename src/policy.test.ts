import { describe, expect, test } from "bun:test";
import { evaluateSend, DEFAULT_MAX_SATS } from "./policy";

describe("evaluateSend", () => {
  test("allows a send under the sat cap when killfile is off", () => {
    const d = evaluateSend({ maxSatsPerTx: DEFAULT_MAX_SATS, killfileOn: false }, 1000, "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT");
    expect(d.ok).toBe(true);
  });

  test("rejects amount over the sat cap with a structured reason", () => {
    const d = evaluateSend({ maxSatsPerTx: 10_000, killfileOn: false }, 10_001, "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("CAP");
    expect(d.message).toContain("10000");
    expect(d.message).toContain("10001");
  });

  test("rejects when killfile is on", () => {
    const d = evaluateSend({ maxSatsPerTx: 10_000, killfileOn: true }, 100, "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("KILL");
    expect(d.message).toContain("STOP_SPENDING");
  });

  test("rejects a non-P2PKH address", () => {
    const d = evaluateSend({ maxSatsPerTx: 10_000, killfileOn: false }, 100, "not-an-address");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("BAD_ADDRESS");
  });

  test("rejects zero, negative, and non-integer amounts", () => {
    for (const amount of [0, -1, 1.5, NaN, Infinity]) {
      const d = evaluateSend({ maxSatsPerTx: 10_000, killfileOn: false }, amount, "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT");
      expect(d.ok).toBe(false);
      if (d.ok) return;
      expect(d.code).toBe("BAD_AMOUNT");
    }
  });

  test("rejection message never contains a WIF-shaped secret", () => {
    const d = evaluateSend({ maxSatsPerTx: 1, killfileOn: true }, 2, "bad");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.message).not.toMatch(/[5KL][1-9A-HJ-NP-Za-km-z]{50,}/);
  });
});
