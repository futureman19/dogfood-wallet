import { describe, expect, test } from "bun:test";
import { evaluateSend, usageFromLog, evaluateSweep, evaluateSplit, planSplit, DEFAULT_MAX_SATS, MIN_SPLIT_PIECE, type Policy } from "./policy";

const TO = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";
const OTHER = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function base(over: Partial<Policy> = {}): Policy {
  return {
    maxSatsPerTx: DEFAULT_MAX_SATS,
    maxSatsPerDay: null,
    maxSatsLifetime: null,
    allowlist: null,
    killfileOn: false,
    ...over,
  };
}

describe("evaluateSend", () => {
  test("allows a send under the sat cap when killfile is off", () => {
    expect(evaluateSend(base(), 1000, TO).ok).toBe(true);
  });

  test("rejects amount over the sat cap with a structured reason", () => {
    const d = evaluateSend(base({ maxSatsPerTx: 10_000 }), 10_001, TO);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("CAP");
    expect(d.message).toContain("10000");
    expect(d.message).toContain("10001");
  });

  test("rejects when killfile is on", () => {
    const d = evaluateSend(base({ killfileOn: true }), 100, TO);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("KILL");
    expect(d.message).toContain("STOP_SPENDING");
  });

  test("rejects a non-P2PKH address", () => {
    const d = evaluateSend(base(), 100, "not-an-address");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("BAD_ADDRESS");
  });

  test("rejects zero, negative, and non-integer amounts", () => {
    for (const amount of [0, -1, 1.5, NaN, Infinity]) {
      const d = evaluateSend(base(), amount, TO);
      expect(d.ok).toBe(false);
      if (d.ok) return;
      expect(d.code).toBe("BAD_AMOUNT");
    }
  });

  test("rejection message never contains a WIF-shaped secret", () => {
    const d = evaluateSend(base({ maxSatsPerTx: 1, killfileOn: true }), 2, "bad");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.message).not.toMatch(/[5KL][1-9A-HJ-NP-Za-km-z]{50,}/);
  });

  test("rejects when destination is not on a non-empty allowlist", () => {
    const d = evaluateSend(base({ allowlist: [TO] }), 100, OTHER);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("ALLOWLIST");
    expect(d.message).toContain("allowlist");
  });

  test("allows a destination on the allowlist", () => {
    expect(evaluateSend(base({ allowlist: [TO] }), 100, TO).ok).toBe(true);
  });

  test("empty allowlist denies every destination", () => {
    const d = evaluateSend(base({ allowlist: [] }), 100, TO);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("ALLOWLIST");
  });

  test("null allowlist is unrestricted", () => {
    expect(evaluateSend(base({ allowlist: null }), 100, OTHER).ok).toBe(true);
  });

  test("rejects when daily cap would be exceeded", () => {
    const d = evaluateSend(base({ maxSatsPerDay: 5_000 }), 1_000, TO, {
      spentToday: 4_200,
      spentLifetime: 4_200,
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("DAY");
    expect(d.message).toContain("4200");
    expect(d.message).toContain("5000");
  });

  test("allows a send that fits the remaining daily cap", () => {
    const d = evaluateSend(base({ maxSatsPerDay: 5_000 }), 800, TO, {
      spentToday: 4_200,
      spentLifetime: 4_200,
    });
    expect(d.ok).toBe(true);
  });

  test("rejects when lifetime cap would be exceeded", () => {
    const d = evaluateSend(base({ maxSatsLifetime: 10_000 }), 100, TO, {
      spentToday: 0,
      spentLifetime: 9_950,
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("LIFETIME");
  });
});

describe("usageFromLog", () => {
  test("sums amounts for today in UTC and lifetime", () => {
    const now = new Date("2026-10-07T15:00:00.000Z");
    const usage = usageFromLog(
      [
        '{"t":"2026-10-06T23:00:00.000Z","amount":7000}',
        '{"t":"2026-10-07T01:00:00.000Z","amount":300}',
        '{"t":"2026-10-07T14:00:00.000Z","amount":50}',
        "not-json",
      ],
      now,
    );
    expect(usage.spentToday).toBe(350);
    expect(usage.spentLifetime).toBe(7350);
  });

  test("treats missing amount as zero", () => {
    const usage = usageFromLog(['{"t":"2026-10-07T00:00:00.000Z"}'], new Date("2026-10-07T12:00:00.000Z"));
    expect(usage.spentToday).toBe(0);
    expect(usage.spentLifetime).toBe(0);
  });

  test("ignores sweep and split log kinds so reclaim does not eat caps", () => {
    const now = new Date("2026-10-07T15:00:00.000Z");
    const usage = usageFromLog(
      [
        '{"t":"2026-10-07T01:00:00.000Z","amount":100,"kind":"send"}',
        '{"t":"2026-10-07T02:00:00.000Z","amount":4990000,"kind":"sweep"}',
        '{"t":"2026-10-07T03:00:00.000Z","amount":0,"kind":"split"}',
        '{"t":"2026-10-07T04:00:00.000Z","amount":50}',
      ],
      now,
    );
    expect(usage.spentToday).toBe(150);
    expect(usage.spentLifetime).toBe(150);
  });
});

describe("evaluateSweep", () => {
  test("allows a P2PKH destination even with killfile, empty allowlist, and tiny per-tx cap", () => {
    const d = evaluateSweep(base({ killfileOn: true, allowlist: [], maxSatsPerTx: 1 }), TO);
    expect(d.ok).toBe(true);
  });

  test("rejects a bad address", () => {
    const d = evaluateSweep(base(), "not-an-address");
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("BAD_ADDRESS");
  });
});

describe("evaluateSplit", () => {
  test("rejects when killfile is on", () => {
    const d = evaluateSplit(base({ killfileOn: true }), 10_000);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("KILL");
  });

  test("rejects a piece below the dust floor", () => {
    const d = evaluateSplit(base(), MIN_SPLIT_PIECE - 1);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("BAD_AMOUNT");
  });

  test("allows a default-sized piece when killfile is off", () => {
    expect(evaluateSplit(base(), 10_000).ok).toBe(true);
  });
});

describe("planSplit", () => {
  test("splits a fat UTXO into at most 20 even pieces", () => {
    const p = planSplit(4_990_020, 10_000, 1);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.pieces.length).toBe(20);
    expect(p.pieces.reduce((s, n) => s + n, 0) + p.fee).toBe(4_990_020);
    expect(p.pieces.every((n) => n >= MIN_SPLIT_PIECE)).toBe(true);
  });

  test("returns INSUFFICIENT when the pile cannot make two min pieces", () => {
    const p = planSplit(1_500, 10_000, 1);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.code).toBe("INSUFFICIENT");
  });
});

