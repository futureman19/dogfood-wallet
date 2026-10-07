import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_SATS, type Policy, type Usage } from "./policy";
import { p2pkhAddressFromLock, type X402Challenge } from "./x402";
import {
  buildPartialTransaction,
  completeDelegation,
  DEFAULT_DELEGATOR_PATH,
  settleX402,
} from "./delegator";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "x402-vectors-v1.json"), "utf8"),
) as {
  vectors: Array<{
    name: string;
    challenge?: X402Challenge;
    rawtx_hex?: string;
    txid?: string;
  }>;
};

function byName(name: string) {
  const v = vectors.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`missing vector ${name}`);
  return v;
}

const ZERO_USAGE: Usage = { spentToday: 0, spentLifetime: 0 };

describe("buildPartialTransaction", () => {
  test("Profile B returns the template hex unchanged", () => {
    const ch = byName("valid_get_empty").challenge!;
    const template = "deadbeef";
    const hex = buildPartialTransaction({
      ...ch,
      template: { rawtx_hex: template, price_sats: 100 },
    });
    expect(hex).toBe(template);
  });

  test("Profile A spends the nonce outpoint and pays amount_sats to the payee script", () => {
    const ch = byName("valid_get_empty").challenge!;
    const hex = buildPartialTransaction(ch);
    const buf = Buffer.from(hex, "hex");
    expect(buf.readUInt32LE(0)).toBe(1);
    let i = 4;
    expect(buf[i]).toBe(1);
    i += 1;
    const prev = buf.subarray(i, i + 32);
    i += 32;
    expect(prev.toString("hex")).toBe(Buffer.from(ch.nonce_utxo!.txid, "hex").reverse().toString("hex"));
    expect(buf.readUInt32LE(i)).toBe(ch.nonce_utxo!.vout);
    i += 4;
    expect(buf[i]).toBe(0);
    i += 1;
    expect(buf.readUInt32LE(i)).toBe(0xffffffff);
    i += 4;
    expect(buf[i]).toBe(1);
    i += 1;
    expect(Number(buf.readBigUInt64LE(i))).toBe(ch.amount_sats);
    i += 8;
    const script = Buffer.from(ch.payee_locking_script_hex, "hex");
    expect(buf[i]).toBe(script.length);
    i += 1;
    expect(buf.subarray(i, i + script.length).toString("hex")).toBe(script.toString("hex"));
    i += script.length;
    expect(buf.readUInt32LE(i)).toBe(0);
    i += 4;
    expect(i).toBe(buf.length);
  });

  test("refuses a challenge with no nonce and no template", () => {
    const ch = { ...byName("valid_get_empty").challenge! };
    delete ch.nonce_utxo;
    expect(() => buildPartialTransaction(ch)).toThrow(/nonce/i);
  });
});

describe("completeDelegation", () => {
  test("POSTs {partial_tx} to /delegate/x402 and returns completed_tx + txid", async () => {
    const completed = byName("txid_derivation");
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(
        JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const out = await completeDelegation({
      url: "http://delegator.example",
      input: {
        partialTxHex: "aa",
        nonceUtxo: { txid: "bb", vout: 0 },
        challengeHash: "cc",
      },
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://delegator.example${DEFAULT_DELEGATOR_PATH}`);
    expect(JSON.parse(calls[0].body)).toEqual({ partial_tx: "aa" });
    expect(out).toEqual({ txid: completed.txid, rawtxHex: completed.rawtx_hex });
  });

  test("strips a trailing slash on the base URL", async () => {
    let hit = "";
    const fetchFn = async (url: string) => {
      hit = String(url);
      return new Response(JSON.stringify({ completed_tx: "00", txid: "11".repeat(32) }), { status: 200 });
    };
    await completeDelegation({
      url: "http://delegator.example/",
      input: { partialTxHex: "aa", nonceUtxo: { txid: "bb", vout: 0 }, challengeHash: "cc" },
      fetchFn,
    });
    expect(hit).toBe("http://delegator.example/delegate/x402");
  });

  test("maps a non-OK delegator status to DELEGATOR", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "no_fee_utxo" }), { status: 503 });
    await expect(
      completeDelegation({
        url: "http://delegator.example",
        input: { partialTxHex: "aa", nonceUtxo: { txid: "bb", vout: 0 }, challengeHash: "cc" },
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "DELEGATOR" });
  });
});

describe("settleX402", () => {
  const ch = byName("valid_get_empty").challenge!;
  const payee = p2pkhAddressFromLock(ch.payee_locking_script_hex)!;
  const policy: Policy = {
    maxSatsPerTx: DEFAULT_MAX_SATS,
    maxSatsPerDay: 50_000,
    maxSatsLifetime: null,
    allowlist: [payee],
    killfileOn: false,
  };

  test("does not fetch when DOGFOOD_X402_DELEGATOR_URL is unset", async () => {
    const prev = process.env.DOGFOOD_X402_DELEGATOR_URL;
    delete process.env.DOGFOOD_X402_DELEGATOR_URL;
    let hits = 0;
    const fetchFn = async () => {
      hits += 1;
      return new Response("no", { status: 500 });
    };
    try {
      const r = await settleX402({
        policy,
        usage: ZERO_USAGE,
        challenge: ch,
        fetchFn,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NEED_DELEGATOR");
      expect(r.broadcast).toBe(false);
      expect(hits).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DOGFOOD_X402_DELEGATOR_URL;
      else process.env.DOGFOOD_X402_DELEGATOR_URL = prev;
    }
  });

  test("does not call the delegator when the allowlist would refuse", async () => {
    let hits = 0;
    const fetchFn = async () => {
      hits += 1;
      return new Response("no", { status: 500 });
    };
    const r = await settleX402({
      policy: { ...policy, allowlist: [] },
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ALLOWLIST");
    expect(hits).toBe(0);
    expect(r.broadcast).toBe(false);
  });

  test("builds a proof from the completed tx and never broadcasts", async () => {
    const completed = byName("txid_derivation");
    const calls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url} ${init?.body}`);
      return new Response(
        JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }),
        { status: 200 },
      );
    };
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
    });
    expect(r.ok).toBe(true);
    expect(r.broadcast).toBe(false);
    expect(r.txid).toBe(completed.txid);
    expect(r.proof?.payment.txid).toBe(completed.txid);
    expect(r.header).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].startsWith("POST http://delegator.example/delegate/x402")).toBe(true);
  });

  test("broadcast:true POSTs the completed tx via broadcastFn", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    const sent: string[] = [];
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      broadcast: true,
      broadcastFn: async (raw) => {
        sent.push(raw);
        return { txid: completed.txid! };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.broadcast).toBe(true);
    expect(sent).toEqual([completed.rawtx_hex]);
  });

  test("explicit broadcast:false wins over DOGFOOD_X402_BROADCAST=1", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    let hits = 0;
    const prev = process.env.DOGFOOD_X402_BROADCAST;
    process.env.DOGFOOD_X402_BROADCAST = "1";
    try {
      const r = await settleX402({
        policy,
        usage: ZERO_USAGE,
        challenge: ch,
        delegatorUrl: "http://delegator.example",
        fetchFn,
        broadcast: false,
        broadcastFn: async () => {
          hits += 1;
          return { txid: completed.txid! };
        },
      });
      expect(r.ok).toBe(true);
      expect(r.broadcast).toBe(false);
      expect(hits).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DOGFOOD_X402_BROADCAST;
      else process.env.DOGFOOD_X402_BROADCAST = prev;
    }
  });

  test("DOGFOOD_X402_BROADCAST=1 enables broadcast when the flag is omitted", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    let hits = 0;
    const prev = process.env.DOGFOOD_X402_BROADCAST;
    process.env.DOGFOOD_X402_BROADCAST = "1";
    try {
      const r = await settleX402({
        policy,
        usage: ZERO_USAGE,
        challenge: ch,
        delegatorUrl: "http://delegator.example",
        fetchFn,
        broadcastFn: async () => {
          hits += 1;
          return { txid: completed.txid! };
        },
      });
      expect(r.ok).toBe(true);
      expect(r.broadcast).toBe(true);
      expect(hits).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.DOGFOOD_X402_BROADCAST;
      else process.env.DOGFOOD_X402_BROADCAST = prev;
    }
  });

  test("broadcast failure is BROADCAST and not ok", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      broadcast: true,
      broadcastFn: async () => {
        throw new Error("ARC 400");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BROADCAST");
    expect(r.broadcast).toBe(false);
  });

  test("does not call the delegator when BRC-181 dest is off-allowlist", async () => {
    const vectors181 = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "testdata", "brc-181-vectors.json"), "utf8"),
    );
    const envelope = {
      payload: JSON.parse(vectors181.vectorA.canonical),
      sig: {
        alg: "ECDSA-SHA256-secp256k1",
        issuer: vectors181.vectorA.issuer,
        signature: vectors181.vectorA.signature,
      },
    };
    let hits = 0;
    const fetchFn = async () => {
      hits += 1;
      return new Response("no", { status: 500 });
    };
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      envelope,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY");
    expect(hits).toBe(0);
  });

  test("does not call the delegator when BRC-181 per-tx cap would fail", async () => {
    const vectors181 = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "testdata", "brc-181-vectors.json"), "utf8"),
    );
    const envelope = {
      payload: JSON.parse(vectors181.vectorA.canonical),
      sig: {
        alg: "ECDSA-SHA256-secp256k1",
        issuer: vectors181.vectorA.issuer,
        signature: vectors181.vectorA.signature,
      },
    };
    const vectorLock = "76a914" + "11".repeat(20) + "88ac";
    const vectorPayee = p2pkhAddressFromLock(vectorLock)!;
    let hits = 0;
    const fetchFn = async () => {
      hits += 1;
      return new Response("no", { status: 500 });
    };
    const r = await settleX402({
      policy: { ...policy, allowlist: [vectorPayee] },
      usage: ZERO_USAGE,
      challenge: { ...ch, amount_sats: 101, payee_locking_script_hex: vectorLock },
      delegatorUrl: "http://delegator.example",
      fetchFn,
      envelope,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY");
    expect(hits).toBe(0);
  });
});
