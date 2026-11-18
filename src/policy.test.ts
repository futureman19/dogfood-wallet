import { describe, expect, test } from "bun:test";
import { evaluateSend, usageFromLog, evaluateSweep, evaluateSplit, evaluateAllowanceFund, planSplit, DEFAULT_MAX_SATS, MIN_SPLIT_PIECE, parseMessagesPolicy, evaluateMessageSend, messageCountFromLog, type Policy, type MessagesPolicy } from "./policy";
import { parseStoredPolicy } from "./vault";

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
        '{"t":"2026-10-07T05:00:00.000Z","amount":200,"kind":"allowance-fund"}',
        '{"t":"2026-10-07T06:00:00.000Z","amount":200,"kind":"allowance-sweep"}',
      ],
      now,
    );
    expect(usage.spentToday).toBe(350);
    expect(usage.spentLifetime).toBe(350);
  });
});

describe("evaluateAllowanceFund", () => {
  test("allows a fund under the sat cap even with an empty allowlist", () => {
    expect(evaluateAllowanceFund(base({ allowlist: [] }), 1000).ok).toBe(true);
  });

  test("rejects when killfile is on", () => {
    const d = evaluateAllowanceFund(base({ killfileOn: true }), 100);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("KILL");
  });

  test("rejects amount over the sat cap", () => {
    const d = evaluateAllowanceFund(base({ maxSatsPerTx: 10_000 }), 10_001);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("CAP");
  });

  test("rejects when daily cap would be exceeded", () => {
    const d = evaluateAllowanceFund(base({ maxSatsPerDay: 5_000 }), 1_000, {
      spentToday: 4_200,
      spentLifetime: 4_200,
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("DAY");
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

// ---- S2: policy.messages ----

const MSG: MessagesPolicy = { maxPerDay: 100, maxBodyBytes: 4096, recipients: null };

describe("parseMessagesPolicy", () => {
  test("absent block means disabled", () => {
    expect(parseMessagesPolicy(undefined)).toBeUndefined();
    expect(parseMessagesPolicy(null)).toBeUndefined();
  });

  test("empty block gets safe defaults", () => {
    expect(parseMessagesPolicy({})).toEqual({ maxPerDay: 100, maxBodyBytes: 4096, recipients: null });
  });

  test("full block round-trips", () => {
    const raw = { maxPerDay: 5, maxBodyBytes: 280, recipients: [TO] };
    expect(parseMessagesPolicy(raw)).toEqual(raw);
  });

  test("non-object blocks throw (fail closed)", () => {
    for (const bad of ["yes", 5, true, []]) expect(() => parseMessagesPolicy(bad)).toThrow();
  });

  test("malformed maxPerDay throws", () => {
    for (const bad of [0, -1, 1.5, "5", null]) expect(() => parseMessagesPolicy({ maxPerDay: bad })).toThrow();
  });

  test("malformed maxBodyBytes throws", () => {
    for (const bad of [0, -1, 1.5, "4096"]) expect(() => parseMessagesPolicy({ maxBodyBytes: bad })).toThrow();
  });

  test("recipients must be null or an array of valid mainnet addresses", () => {
    expect(parseMessagesPolicy({ recipients: null })!.recipients).toBeNull();
    expect(() => parseMessagesPolicy({ recipients: "1abc" })).toThrow();
    expect(() => parseMessagesPolicy({ recipients: [5] })).toThrow();
    expect(() => parseMessagesPolicy({ recipients: ["not-an-address"] })).toThrow();
    expect(() => parseMessagesPolicy({ recipients: ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"] })).toThrow(); // P2SH
  });

  test("parseStoredPolicy wires the messages block", () => {
    const p = parseStoredPolicy(JSON.stringify({ messages: { maxPerDay: 7 } }), false);
    expect(p.messages).toEqual({ maxPerDay: 7, maxBodyBytes: 4096, recipients: null });
    expect(parseStoredPolicy("{}", false).messages).toBeUndefined();
    expect(() => parseStoredPolicy(JSON.stringify({ messages: { maxPerDay: -3 } }), false)).toThrow();
  });
});

describe("evaluateMessageSend", () => {
  test("absent policy disables messaging", () => {
    const d = evaluateMessageSend(undefined, false, TO, 10, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("DISABLED");
  });

  test("killfile wins over an otherwise valid message", () => {
    const d = evaluateMessageSend(MSG, true, TO, 10, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("KILL");
  });

  test("rejects a non-mainnet recipient", () => {
    const d = evaluateMessageSend(MSG, false, "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", 10, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("BAD_ADDRESS");
  });

  test("empty recipients allowlist rejects everyone", () => {
    const d = evaluateMessageSend({ ...MSG, recipients: [] }, false, TO, 10, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("ALLOWLIST");
  });

  test("recipient outside the allowlist is rejected", () => {
    const d = evaluateMessageSend({ ...MSG, recipients: [OTHER] }, false, TO, 10, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("ALLOWLIST");
  });

  test("listed recipient is allowed", () => {
    expect(evaluateMessageSend({ ...MSG, recipients: [TO] }, false, TO, 10, 0).ok).toBe(true);
  });

  test("body over the byte cap is rejected; at the cap is allowed", () => {
    const over = evaluateMessageSend({ ...MSG, maxBodyBytes: 10 }, false, TO, 11, 0);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("CAP");
    expect(evaluateMessageSend({ ...MSG, maxBodyBytes: 10 }, false, TO, 10, 0).ok).toBe(true);
  });

  test("daily count cap is reached at maxPerDay", () => {
    const d = evaluateMessageSend({ ...MSG, maxPerDay: 2 }, false, TO, 10, 2);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("DAY");
    expect(evaluateMessageSend({ ...MSG, maxPerDay: 2 }, false, TO, 10, 1).ok).toBe(true);
  });
});

describe("messages usage scope", () => {
  const NOW = new Date("2026-11-17T12:00:00Z");
  const today = NOW.toISOString();
  const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString();
  const txid = "ab".repeat(32);
  const lines = [
    JSON.stringify({ kind: "agent-message", t: today, amount: 1, fee: 300, to: TO, txid }),
    JSON.stringify({ kind: "send", t: today, amount: 5000, fee: 10, to: TO, txid }),
    JSON.stringify({ kind: "attest", t: today, amount: 0, fee: 200, to: "attest", txid }),
    JSON.stringify({ kind: "agent-message", t: yesterday, amount: 1, fee: 250, to: TO, txid }),
  ];

  test("messages scope counts only agent-message rows, fee-inclusive", () => {
    const u = usageFromLog(lines, NOW, "messages");
    expect(u.spentToday).toBe(301);
    expect(u.spentLifetime).toBe(552);
  });

  test("message rows also feed the plain bsv and brc181-bsv scopes", () => {
    expect(usageFromLog(lines, NOW, "bsv").spentToday).toBe(5001);
    expect(usageFromLog(lines, NOW, "brc181-bsv").spentToday).toBe(5511);
  });

  test("messageCountFromLog counts today's agent-message rows only", () => {
    expect(messageCountFromLog(lines, NOW)).toBe(1);
    expect(messageCountFromLog([], NOW)).toBe(0);
  });

  test("corrupt log lines fail closed for both readers", () => {
    expect(() => usageFromLog(["{corrupt", ...lines], NOW, "messages")).toThrow();
    expect(() => messageCountFromLog(["{corrupt"], NOW)).toThrow();
  });
});

