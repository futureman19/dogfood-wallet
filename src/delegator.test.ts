import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { DEFAULT_MAX_SATS, type Policy, type Usage } from "./policy";
import { p2pkhAddressFromLock, type X402Challenge } from "./x402";
import {
  buildClientFundedPartialTx,
  completeDelegation,
  DEFAULT_DELEGATOR_PATH,
  settleX402,
  type X402Funding,
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

const fundKey = PrivateKey.fromRandom();
const fundAddr = fundKey.toAddress().toString();
const fundLock = new P2PKH().lock(fundAddr).toHex();

function sourceTx(sats: number): { id: string; hex: string } {
  const t = new Transaction();
  t.addOutput({ satoshis: sats, lockingScript: Script.fromHex(fundLock) });
  return { id: t.id("hex"), hex: t.toHex() };
}

function fundingFor(values: number[]): X402Funding {
  const txs = values.map(sourceTx);
  return {
    key: fundKey,
    address: fundAddr,
    fetchUtxos: async () => txs.map((t, i) => ({ tx_hash: t.id, tx_pos: 0, value: values[i] })),
    fetchTxHex: async (txid: string) => {
      const found = txs.find((t) => t.id === txid);
      if (!found) throw new Error(`no source tx ${txid}`);
      return found.hex;
    },
  };
}

const NONCE_TXID = "22".repeat(32);
const NONCE_SCRIPTSIG = "deadbeef";

function challengeWithTemplate(): X402Challenge {
  const base = byName("valid_get_empty").challenge!;
  const tmpl = new Transaction();
  tmpl.addInput({
    sourceTXID: NONCE_TXID,
    sourceOutputIndex: 7,
    unlockingScript: Script.fromHex(NONCE_SCRIPTSIG),
  });
  tmpl.addOutput({
    satoshis: base.amount_sats,
    lockingScript: Script.fromHex(base.payee_locking_script_hex),
  });
  return {
    ...base,
    nonce_utxo: { ...base.nonce_utxo!, txid: NONCE_TXID, vout: 7 },
    template: { rawtx_hex: tmpl.toHex(), price_sats: base.amount_sats },
  };
}

describe("buildClientFundedPartialTx", () => {
  test("nonce input keeps the template script at index 0; vault input signed 0xC3; payee output at 0; change at 1", async () => {
    const ch = challengeWithTemplate();
    const { partialTxHex, changeSats } = await buildClientFundedPartialTx({ challenge: ch, ...fundingFor([10_000]) });
    const tx = Transaction.fromHex(partialTxHex);
    expect(tx.inputs).toHaveLength(2);
    expect(tx.inputs[0].sourceTXID).toBe(NONCE_TXID);
    expect(tx.inputs[0].sourceOutputIndex).toBe(7);
    expect(tx.inputs[0].unlockingScript?.toHex()).toBe(NONCE_SCRIPTSIG);
    const chunks = tx.inputs[1].unlockingScript!.chunks;
    const sig = chunks[0].data!;
    expect(sig[sig.length - 1]).toBe(0xc3);
    expect(tx.outputs[0].satoshis).toBe(ch.amount_sats);
    expect(tx.outputs[0].lockingScript.toHex()).toBe(ch.payee_locking_script_hex);
    expect(tx.outputs[1].satoshis).toBe(10_000 - ch.amount_sats);
    expect(tx.outputs[1].lockingScript.toHex()).toBe(fundLock);
    expect(changeSats).toBe(10_000 - ch.amount_sats);
  });

  test("picks the smallest sufficient UTXO first", async () => {
    const ch = challengeWithTemplate();
    const { partialTxHex, changeSats } = await buildClientFundedPartialTx({
      challenge: ch,
      ...fundingFor([50_000, ch.amount_sats + 5]),
    });
    const tx = Transaction.fromHex(partialTxHex);
    expect(tx.inputs).toHaveLength(2);
    expect(tx.outputs[1].satoshis).toBe(5);
    expect(changeSats).toBe(5);
  });

  test("accumulates multiple UTXOs smallest-first when one cannot cover", async () => {
    const ch = challengeWithTemplate();
    const { partialTxHex, changeSats } = await buildClientFundedPartialTx({
      challenge: ch,
      ...fundingFor([ch.amount_sats - 1, 10]),
    });
    const tx = Transaction.fromHex(partialTxHex);
    expect(tx.inputs).toHaveLength(3);
    expect(changeSats).toBe(9);
  });

  test("rejects when the vault cannot cover the amount", async () => {
    const ch = challengeWithTemplate();
    await expect(
      buildClientFundedPartialTx({ challenge: ch, ...fundingFor([ch.amount_sats - 1]) }),
    ).rejects.toThrow(/cannot fund|insufficient/i);
  });

  test("leaves the nonce input unsigned when there is no template", async () => {
    const ch = byName("valid_get_empty").challenge!;
    const { partialTxHex } = await buildClientFundedPartialTx({ challenge: ch, ...fundingFor([10_000]) });
    const tx = Transaction.fromHex(partialTxHex);
    expect(tx.inputs[0].unlockingScript === undefined || tx.inputs[0].unlockingScript!.toHex() === "").toBe(true);
  });

  test("omits change when the UTXO exactly covers the amount", async () => {
    const ch = challengeWithTemplate();
    const { partialTxHex, changeSats } = await buildClientFundedPartialTx({
      challenge: ch,
      ...fundingFor([ch.amount_sats]),
    });
    const tx = Transaction.fromHex(partialTxHex);
    expect(tx.outputs).toHaveLength(1);
    expect(changeSats).toBe(0);
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
      fund: fundingFor([10_000]),
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
      fund: fundingFor([10_000]),
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
        fund: fundingFor([10_000]),
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
        fund: fundingFor([10_000]),
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
      fund: fundingFor([10_000]),
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

  test("requires vault funding (NEED_FUNDS) and never calls the delegator", async () => {
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
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NEED_FUNDS");
    expect(hits).toBe(0);
  });

  test("gateway-template challenge without fund settles sponsored: vaultPaid false, no spend logged", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.partial_tx).toBe(challengeWithTemplate().template!.rawtx_hex);
      return new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    };
    const spends: Array<Record<string, unknown>> = [];
    const sponsored = challengeWithTemplate();
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: sponsored,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      broadcast: true,
      broadcastFn: async () => ({ txid: completed.txid! }),
      onSpend: (e) => spends.push(e),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vaultPaid).toBe(false);
      expect(r.changeSats).toBe(0);
      expect(r.message).toMatch(/sponsored/i);
    }
    expect(r.broadcast).toBe(true);
    expect(spends).toHaveLength(0);
  });

  test("reports the spend via onSpend only after a successful broadcast", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    const spends: Array<Record<string, unknown>> = [];
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      fund: fundingFor([10_000]),
      broadcast: true,
      broadcastFn: async () => ({ txid: completed.txid! }),
      onSpend: (e) => spends.push(e),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vaultPaid).toBe(true);
      expect(r.changeSats).toBe(10_000 - ch.amount_sats);
    }
    expect(spends).toHaveLength(1);
    expect(spends[0].amount).toBe(ch.amount_sats);
    expect(spends[0].kind).toBe("x402");
    expect(spends[0].txid).toBe(completed.txid);
    expect(spends[0].to).toBe(payee);
  });

  test("no spend is reported when broadcast is off", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    const spends: Array<Record<string, unknown>> = [];
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      fund: fundingFor([10_000]),
      onSpend: (e) => spends.push(e),
    });
    expect(r.ok).toBe(true);
    expect(r.broadcast).toBe(false);
    expect(spends).toHaveLength(0);
  });

  test("no spend is reported when broadcast fails", async () => {
    const completed = byName("txid_derivation");
    const fetchFn = async () =>
      new Response(JSON.stringify({ completed_tx: completed.rawtx_hex, txid: completed.txid }), { status: 200 });
    const spends: Array<Record<string, unknown>> = [];
    const r = await settleX402({
      policy,
      usage: ZERO_USAGE,
      challenge: ch,
      delegatorUrl: "http://delegator.example",
      fetchFn,
      fund: fundingFor([10_000]),
      broadcast: true,
      broadcastFn: async () => {
        throw new Error("ARC 400");
      },
      onSpend: (e) => spends.push(e),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BROADCAST");
    expect(spends).toHaveLength(0);
  });
});
