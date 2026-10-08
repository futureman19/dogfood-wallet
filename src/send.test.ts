import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, killVault, allowDestination } from "./vault";
import { sendPayment, sweepPayment, splitPayment, selectUtxos, defaultBroadcast } from "./send";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-send-"));
}

const TO = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";

describe("selectUtxos", () => {
  test("prefers the smallest coin that covers amount plus fee", () => {
    const { chosen } = selectUtxos(
      [
        { tx_hash: "aa", tx_pos: 0, value: 100_000 },
        { tx_hash: "bb", tx_pos: 0, value: 5_000 },
        { tx_hash: "cc", tx_pos: 0, value: 20_000 },
      ],
      100,
    );
    expect(chosen.map((u) => u.tx_hash)).toEqual(["bb"]);
  });
});

describe("sendPayment policy gate", () => {
  test("does not fetch UTXOs when over cap", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 10_001,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("CAP");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not fetch UTXOs when killfile is on", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      killVault(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 100,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("KILL");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns INSUFFICIENT when funded below amount plus fee", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      const result = await sendPayment({
        root,
        to: TO,
        amount: 1000,
        fetchUtxos: async () => [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 50 }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INSUFFICIENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not fetch UTXOs when allowlist is empty", async () => {
    const root = scratch();
    try {
      initVault(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 100,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ALLOWLIST");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const VECTOR_DEST = "12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH";

function writeVectorAEnvelope(root: string) {
  const vectors = JSON.parse(readFileSync(join(import.meta.dir, "..", "testdata", "brc-181-vectors.json"), "utf8"));
  writeFileSync(
    join(root, "brc181.json"),
    JSON.stringify({
      payload: JSON.parse(vectors.vectorA.canonical),
      sig: {
        alg: "ECDSA-SHA256-secp256k1",
        issuer: vectors.vectorA.issuer,
        signature: vectors.vectorA.signature,
      },
    }),
  );
}

describe("sendPayment BRC-181 envelope", () => {
  test("does not fetch when envelope per-tx cap would fail", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, VECTOR_DEST);
      writeVectorAEnvelope(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: VECTOR_DEST,
        amount: 101,
        origin: "agt-marketplace-bidder-01",
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("POLICY");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not fetch when dest is off the signed allowlist", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      writeVectorAEnvelope(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 50,
        origin: "agt-marketplace-bidder-01",
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("POLICY");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepPayment", () => {
  test("fetches UTXOs even when killfile is on and allowlist is empty", async () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      let fetched = false;
      const result = await sweepPayment({
        root,
        to: TO,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(fetched).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INSUFFICIENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a bad sweep destination without fetching", async () => {
    const root = scratch();
    try {
      initVault(root);
      let fetched = false;
      const result = await sweepPayment({
        root,
        to: "bad",
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(fetched).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("BAD_ADDRESS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("splitPayment", () => {
  test("does not fetch UTXOs when killfile is on", async () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      let fetched = false;
      const result = await splitPayment({
        root,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(fetched).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("KILL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns INSUFFICIENT on an empty vault", async () => {
    const root = scratch();
    try {
      initVault(root);
      const result = await splitPayment({
        root,
        fetchUtxos: async () => [],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INSUFFICIENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("defaultBroadcast", () => {
  const raw = "aa";
  const fee465 = JSON.stringify({
    detail: "arc error 465: transaction fee is too low\nminimum expected fee: 34, actual fee: 1",
  });

  test("falls back to WoC when ARC rejects for fee policy", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: unknown) => {
      calls.push(String(url));
      if (String(url).includes("arc")) return new Response(fee465, { status: 465 });
      return new Response(JSON.stringify("11".repeat(32)), { status: 200 });
    };
    const out = await defaultBroadcast(raw, fetchFn as typeof fetch);
    expect(out.txid).toBe("11".repeat(32));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("whatsonchain");
  });

  test("does not fall back on a non-fee rejection", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ detail: "missing inputs" }), { status: 400 });
    };
    await expect(defaultBroadcast(raw, fetchFn as typeof fetch)).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  test("returns the ARC txid without touching WoC when accepted", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ txid: "22".repeat(32) }), { status: 200 });
    };
    const out = await defaultBroadcast(raw, fetchFn as typeof fetch);
    expect(out.txid).toBe("22".repeat(32));
    expect(calls).toHaveLength(1);
  });
});
