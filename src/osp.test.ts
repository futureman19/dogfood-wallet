import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { initVault, killVault, loadUsage, loadVault, vaultPaths } from "./vault";
import { doorInit, listOspDoors, loadOspDoor, revokeOspDoor, signOspGrant } from "./osp";
import { approveRequest, fileRequest } from "./requests";
import { bytesToHex, decode, hexToBytes, reverseHexBytes } from "./osp-envelope";
import { jcs, scopeHashHex } from "./osp-scope";
import { ospAddress, ospTipScriptHex } from "./osp-address";
import { inspectPaymentHold } from "./payment-guard";
import { mockFetch } from "./test-support/fetch";

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const ARC = "https://arc.gorillapool.io/v1/tx";
const UNPAID_SCOPE = '{"allow":["read:users"],"rate":"60/min","salt":"00112233445566778899aabbccddeeff"}';
const SESSION_PUB = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"; // published vector key, never funded

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-osp-"));
}

/** Vault with an OSP policy block and one 100k-sat coin on a mock chain. */
function fundedVault(root: string, osp: { maxSatsPerTx: number; maxSatsPerDay: number | null } = { maxSatsPerTx: 1000, maxSatsPerDay: 5000 }) {
  initVault(root);
  const raw = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
  raw.osp = osp;
  writeFileSync(vaultPaths(root).policy, JSON.stringify(raw, null, 2) + "\n");
  const vault = loadVault(root);
  const vaultScript = new P2PKH().lock(vault.address).toHex();
  const tipScript = ospTipScriptHex(vault.key);
  const owner = ospAddress(vault.key);

  const seed = new Transaction();
  seed.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
  seed.addOutput({ satoshis: 100_000, lockingScript: Script.fromHex(vaultScript) });

  const state = {
    tip: null as { txid: string; vout: number } | null,
    txs: new Map<string, string>([[seed.id("hex"), seed.toHex()]]),
    broadcasts: [] as Transaction[],
  };
  const fetchFn = mockFetch(async (input, init) => {
    const u = String(input);
    if (u === `${WOC}/address/${vault.address}/unspent`) {
      return Response.json([{ tx_hash: seed.id("hex"), tx_pos: 0, value: 100_000 }]);
    }
    if (u === `${WOC}/address/${owner}/unspent`) {
      return Response.json(state.tip ? [{ tx_hash: state.tip.txid, tx_pos: state.tip.vout, value: 1 }] : []);
    }
    const hexMatch = u.match(new RegExp(`^${WOC}/tx/([0-9a-f]{64})/hex$`));
    if (hexMatch) {
      const hex = state.txs.get(hexMatch[1]!);
      if (!hex) throw new Error("Unexpected network: unknown tx " + hexMatch[1]);
      return new Response(hex);
    }
    if (u === ARC && init?.method === "POST") {
      const raw = (JSON.parse(String(init.body)) as { rawTx: string }).rawTx;
      const tx = Transaction.fromHex(raw);
      const txid = tx.id("hex");
      state.txs.set(txid, raw);
      state.broadcasts.push(tx);
      state.tip = null;
      tx.outputs.forEach((o, i) => {
        if (o.satoshis === 1 && o.lockingScript.toHex() === tipScript) state.tip = { txid, vout: i };
      });
      return Response.json({ txid, txStatus: "SEEN_ON_NETWORK" });
    }
    throw new Error(`Unexpected network: ${u}`);
  });
  return { vault, vaultScript, tipScript, owner, state, fetchFn, seedTxid: seed.id("hex") };
}

function paidScope(payeeScript: string): string {
  return jcs({ allow: ["read:users"], payment: { amount_sats: 10, script: payeeScript }, salt: "ff".repeat(16) });
}
function envelopeOutputs(tx: Transaction): { script: string; index: number }[] {
  return tx.outputs.map((o, i) => ({ script: o.lockingScript.toHex(), index: i })).filter((o) => o.script.startsWith("006a"));
}

describe("OSP door lifecycle on a mock chain (real signing, real guard, mock WoC/ARC)", () => {
  test("init → unpaid grant → paid grant → revoke-close, every byte asserted", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);

      // --- door genesis ---
      const init = await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      expect(init.registration.genesisDisplayTxid).toBe(init.txid);
      expect(init.registration.tipLockingScriptHex).toBe(f.tipScript);
      expect(init.doorIdInternalHex).toBe(reverseHexBytes(init.txid));
      const genesis = f.state.broadcasts[0]!;
      expect(genesis.inputs).toHaveLength(1);
      expect(genesis.outputs[0]!.satoshis).toBe(1);
      expect(genesis.outputs[0]!.lockingScript.toHex()).toBe(f.tipScript);
      expect(genesis.outputs[1]!.lockingScript.toHex()).toBe(f.vaultScript); // change home
      let door = loadOspDoor(root, "bench");
      expect(door.status).toBe("open");
      expect(door.tip).toEqual({ txid: init.txid, vout: 0 });
      expect(door.seen).toEqual([init.txid]);

      // --- unpaid grant with an explicit agent session key ---
      const g1 = await signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: SESSION_PUB, fetchFn: f.fetchFn });
      expect(g1.paymentSats).toBe(0);
      const grant1 = f.state.broadcasts[1]!;
      expect(grant1.inputs[0]!.sourceTXID).toBe(init.txid); // OSP-0001: tip spend is input[0]
      expect(grant1.inputs[0]!.sourceOutputIndex).toBe(0);
      expect(grant1.inputs).toHaveLength(2); // tip + funding
      expect(grant1.outputs[0]!.satoshis).toBe(1);
      expect(grant1.outputs[0]!.lockingScript.toHex()).toBe(f.tipScript); // continuation
      const env1Out = envelopeOutputs(grant1);
      expect(env1Out).toHaveLength(1);
      expect(grant1.outputs[env1Out[0]!.index]!.satoshis).toBe(0);
      const env1Script = env1Out[0]!.script;
      expect(env1Script.startsWith("006a4c72")).toBe(true); // OP_0 OP_RETURN PUSHDATA1 0x72=114
      const env1 = decode(hexToBytes(env1Script.slice(8)));
      if (env1.type !== "grant") throw new Error("expected grant envelope");
      expect(bytesToHex(env1.doorId)).toBe(reverseHexBytes(init.txid));
      expect(env1.expiryHeight).toBe(1_000_000);
      expect(env1.maxEgress).toBe(65_536n);
      expect(bytesToHex(env1.scopeHash)).toBe(scopeHashHex(UNPAID_SCOPE));
      expect(bytesToHex(env1.sessionPub)).toBe(SESSION_PUB);
      door = loadOspDoor(root, "bench");
      expect(door.tip).toEqual({ txid: g1.txid, vout: 0 });
      expect(door.seen).toEqual([init.txid, g1.txid]);

      // --- OSP-0005 paid grant: exactly one payment output, inside the scope bytes ---
      const payee = PrivateKey.fromRandom().toAddress();
      const payeeScript = new P2PKH().lock(payee).toHex();
      const scope = paidScope(payeeScript);
      const g2 = await signOspGrant({ root, door: "bench", scopeCanonical: scope, fetchFn: f.fetchFn });
      expect(g2.paymentSats).toBe(10);
      expect(g2.sessionPubHex).toMatch(/^0[23][0-9a-f]{64}$/); // ephemeral session key
      const grant2 = f.state.broadcasts[2]!;
      expect(grant2.inputs[0]!.sourceTXID).toBe(g1.txid);
      expect(grant2.outputs[1]!.satoshis).toBe(10);
      expect(grant2.outputs[1]!.lockingScript.toHex()).toBe(payeeScript);
      expect(grant2.outputs.filter((o) => o.lockingScript.toHex() === payeeScript)).toHaveLength(1); // OSP-0005 uniqueness
      const env2Out = envelopeOutputs(grant2);
      expect(env2Out[0]!.index).toBe(2); // continuation, payment, envelope, change
      const env2 = decode(hexToBytes(env2Out[0]!.script.slice(8)));
      if (env2.type !== "grant") throw new Error("expected grant envelope");
      expect(bytesToHex(env2.scopeHash)).toBe(scopeHashHex(scope));

      // --- revoke-close: envelope only, no continuation, door permanently closed ---
      const rv = await revokeOspDoor({ root, door: "bench", fetchFn: f.fetchFn });
      const close = f.state.broadcasts[3]!;
      expect(close.inputs[0]!.sourceTXID).toBe(g2.txid);
      expect(close.outputs.filter((o) => o.satoshis === 1 && o.lockingScript.toHex() === f.tipScript)).toHaveLength(0);
      const env3Out = envelopeOutputs(close);
      expect(env3Out).toHaveLength(1);
      expect(env3Out[0]!.script.startsWith("006a26")).toBe(true); // direct push, 38 bytes
      const env3 = decode(hexToBytes(env3Out[0]!.script.slice(6)));
      if (env3.type !== "revoke") throw new Error("expected revoke envelope");
      expect(env3.flag).toBe(0);
      expect(bytesToHex(env3.doorId)).toBe(reverseHexBytes(init.txid));
      door = loadOspDoor(root, "bench");
      expect(door.status).toBe("closed");
      expect(door.tip).toBeNull();
      expect(door.seen).toHaveLength(4);
      expect(listOspDoors(root)).toHaveLength(1);
      await expect(revokeOspDoor({ root, door: "bench", fetchFn: f.fetchFn })).rejects.toThrow(/already closed/);
      await expect(signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, fetchFn: f.fetchFn })).rejects.toThrow(/permanently closed/);

      // --- accounting: every sat that left the vault, fee-inclusive ---
      const usage = loadUsage(root, new Date(), "osp");
      expect(usage.spentLifetime).toBe(226 + 408 + (10 + 442) + 374);
      // Ordinary bsv scope counts the payout (fees stay in the osp/brc181
      // scopes) — same doctrine as gryd agent-buy rows counting toward bsv.
      const bsvUsage = loadUsage(root);
      expect(bsvUsage.spentLifetime).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fail-closed when the osp policy block is absent, malformed, capped, or killed", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);
      // absent block → DISABLED before any network
      writeFileSync(vaultPaths(root).policy, JSON.stringify(((r) => { const { osp, ...rest } = r; return rest; })(JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"))), null, 2) + "\n");
      await expect(doorInit({ root, name: "x", fetchFn: f.fetchFn })).rejects.toThrow(/no osp policy/);
      expect(f.state.broadcasts).toHaveLength(0);

      // malformed block → loadVault refuses
      const raw = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
      raw.osp = { maxSatsPerTx: -1, maxSatsPerDay: null };
      writeFileSync(vaultPaths(root).policy, JSON.stringify(raw, null, 2) + "\n");
      await expect(doorInit({ root, name: "x", fetchFn: f.fetchFn })).rejects.toThrow(/osp\.maxSatsPerTx/);

      // per-tx cap binds payment+fee
      raw.osp = { maxSatsPerTx: 100, maxSatsPerDay: null };
      writeFileSync(vaultPaths(root).policy, JSON.stringify(raw, null, 2) + "\n");
      await expect(doorInit({ root, name: "x", fetchFn: f.fetchFn })).rejects.toThrow(/maxSatsPerTx/);

      // killfile wins even with a healthy policy
      raw.osp = { maxSatsPerTx: 1000, maxSatsPerDay: 5000 };
      writeFileSync(vaultPaths(root).policy, JSON.stringify(raw, null, 2) + "\n");
      killVault(root);
      await expect(doorInit({ root, name: "x", fetchFn: f.fetchFn })).rejects.toThrow(/STOP_SPENDING/);
      expect(f.state.broadcasts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tip drift refuses to sign; payment ambiguity refused; bad session key refused", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);
      await doorInit({ root, name: "bench", fetchFn: f.fetchFn });

      // payment to the tip or change script creates door-side output ambiguity
      const toTip = jcs({ payment: { amount_sats: 5, script: f.tipScript }, salt: "ff".repeat(16) });
      await expect(signOspGrant({ root, door: "bench", scopeCanonical: toTip, fetchFn: f.fetchFn })).rejects.toThrow(/ambiguity/);
      const toVault = jcs({ payment: { amount_sats: 5, script: f.vaultScript }, salt: "ff".repeat(16) });
      await expect(signOspGrant({ root, door: "bench", scopeCanonical: toVault, fetchFn: f.fetchFn })).rejects.toThrow(/ambiguity/);

      // session pubkey must be a real on-curve point
      await expect(signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: "02" + "ff".repeat(32), fetchFn: f.fetchFn })).rejects.toThrow(/OSP-0002/);

      // door-file tip drift (external spend) fails closed, never signs over it
      const doorPath = join(vaultPaths(root).ospDoors, "bench.json");
      const door = loadOspDoor(root, "bench");
      writeFileSync(doorPath, JSON.stringify({ ...door, tip: { txid: "11".repeat(32), vout: 0 } }, null, 2) + "\n");
      await expect(signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, fetchFn: f.fetchFn })).rejects.toThrow(/spent externally/);
      expect(f.state.broadcasts).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("request flow: agent files the exact ask; approval signs + broadcasts it", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);
      await doorInit({ root, name: "bench", fetchFn: f.fetchFn });

      // validation at filing time — non-canonical scope never reaches the human
      expect(() => fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: '{"salt":"00112233445566778899aabbccddeeff","allow":["x"]}' })).toThrow(/canonical/);
      expect(() => fileRequest(root, { kind: "osp-grant", door: "bad name", scopeCanonical: UNPAID_SCOPE })).toThrow(/door/);
      expect(() => fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: "zz" })).toThrow(/sessionPubHex/);

      const { request, created } = fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: SESSION_PUB, reason: "agent needs read:users" });
      expect(created).toBe(true);
      expect(fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: SESSION_PUB }).created).toBe(false); // dedupe

      const approved = await approveRequest(root, request.id, { fetchFn: f.fetchFn });
      expect(approved.status).toBe("approved");
      expect(approved.decision).toMatch(/^osp grant broadcast [0-9a-f]{64} on door bench fee /);
      const door = loadOspDoor(root, "bench");
      expect(door.seen).toHaveLength(2);
      const grant = f.state.broadcasts[1]!;
      const envOut = envelopeOutputs(grant);
      const env = decode(hexToBytes(envOut[0]!.script.slice(8)));
      if (env.type !== "grant") throw new Error("expected grant");
      expect(bytesToHex(env.sessionPub)).toBe(SESSION_PUB); // the agent's key, verbatim from the ask
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-approve never double-spends: decided requests are terminal", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);
      await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      const { request } = fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: UNPAID_SCOPE });
      await approveRequest(root, request.id, { fetchFn: f.fetchFn });
      await expect(approveRequest(root, request.id, { fetchFn: f.fetchFn })).rejects.toThrow(/not pending/);
      expect(f.state.broadcasts).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OSP pre-decryption and actual signer boundaries", () => {
  const operations = ["init", "grant", "revoke"] as const;
  function invoke(op: typeof operations[number], root: string, fetchFn: typeof fetch, extra = {}) {
    if (op === "init") return doorInit({ root, name: "new-door", fetchFn });
    if (op === "revoke") return revokeOspDoor({ root, door: "bench", fetchFn });
    return signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: SESSION_PUB, fetchFn, ...extra });
  }
  for (const op of operations) {
    for (const refusal of ["absent", "malformed", "kill", "fee-cap", "day"] as const) {
      test(`${op}: ${refusal} rejects with unusable encrypted key material`, async () => {
        const root = tmp();
        try {
          const f = fundedVault(root);
          if (op !== "init") await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
          const raw = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
          if (refusal === "absent") delete raw.osp;
          if (refusal === "malformed") raw.osp.maxSatsPerTx = -1;
          if (refusal === "fee-cap") raw.osp.maxSatsPerTx = 1;
          if (refusal === "day") {
            raw.osp.maxSatsPerDay = 1;
            writeFileSync(vaultPaths(root).log, JSON.stringify({ t: new Date().toISOString(), asset: "bsv", kind: "osp-grant", amount: 2, fee: 0 }) + "\n");
          }
          writeFileSync(vaultPaths(root).policy, JSON.stringify(raw));
          if (refusal === "kill") killVault(root);
          // A decrypt attempt deterministically fails at createDecipheriv, not policy.
          writeFileSync(vaultPaths(root).wrap, "invalid AES key");
          let reads = 0, mutations = 0;
          const fetchFn = mockFetch(async (url, init) => {
            if (init?.method && init.method !== "GET") { mutations++; throw Error("MUTATION_FORBIDDEN"); }
            reads++; return f.fetchFn(url, init);
          });
          const signing = spyOn(Transaction.prototype, "sign");
          try {
            await expect(invoke(op, root, fetchFn)).rejects.toThrow(refusal === "absent" ? /no osp policy/ : refusal === "kill" ? /STOP_SPENDING/ : refusal === "day" ? /maxSatsPerDay/ : /osp.maxSatsPerTx/);
            expect(signing).not.toHaveBeenCalled();
            expect(mutations).toBe(0);
            if (refusal !== "fee-cap") expect(reads).toBe(0);
            expect(inspectPaymentHold(root).blocked).toBe(false);
          } finally { signing.mockRestore(); }
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
    test(`${op}: kill after key loading at unlock-template construction never enters signer`, async () => {
      const root = tmp();
      try {
        const f = fundedVault(root);
        if (op !== "init") await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
        const original = P2PKH.prototype.unlock;
        const unlocking = spyOn(P2PKH.prototype, "unlock").mockImplementation(function (this: P2PKH, ...args) {
          killVault(root);
          return original.apply(this, args);
        });
        const signing = spyOn(Transaction.prototype, "sign");
        const before = f.state.broadcasts.length;
        try {
          await expect(invoke(op, root, f.fetchFn)).rejects.toThrow(/STOP_SPENDING/);
          expect(unlocking).toHaveBeenCalled();
          expect(signing).not.toHaveBeenCalled();
          expect(f.state.broadcasts).toHaveLength(before);
          // Reservation is conservative: even this unsigned failure stays held.
          expect(inspectPaymentHold(root).pending).toBe("valid");
          expect(inspectPaymentHold(root).blocked).toBe(true);
        } finally { unlocking.mockRestore(); signing.mockRestore(); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    test(`${op}: ambiguous signed broadcast preserves evidence and blocks another signer entry`, async () => {
      const root = tmp();
      try {
        const f = fundedVault(root);
        if (op !== "init") await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
        let mutations = 0;
        const fetchFn = mockFetch(async (url, init) => {
          if (init?.method === "POST") {
            mutations++;
            return Response.json({ txid: "ff".repeat(32), txStatus: "SEEN_ON_NETWORK" });
          }
          return f.fetchFn(url, init);
        });
        const signing = spyOn(Transaction.prototype, "sign");
        try {
          await expect(invoke(op, root, fetchFn)).rejects.toThrow(/Ambiguous/);
          expect(signing).toHaveBeenCalledTimes(1);
          const hold = inspectPaymentHold(root);
          expect(hold.pending).toBe("valid");
          expect(hold.blocked).toBe(true);
          const evidence = readFileSync(join(root, "osp-sends", hold.intent!.id + ".json"), "utf8");
          expect(JSON.parse(evidence).rawTx).toMatch(/^[0-9a-f]+$/);
          await expect(invoke(op, root, fetchFn)).rejects.toThrow(/active or unresolved/);
          expect(signing).toHaveBeenCalledTimes(1);
          expect(mutations).toBe(1);
          expect(readFileSync(join(root, "osp-sends", hold.intent!.id + ".json"), "utf8")).toBe(evidence);
        } finally { signing.mockRestore(); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    for (const timing of ["first", "last"] as const) {
      test(`${op}: STOP_SPENDING during ${timing} async read blocks actual signing`, async () => {
        const root = tmp();
        try {
          const f = fundedVault(root);
          if (op !== "init") await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
          let reads = 0, mutations = 0, injected = false;
          const fetchFn = mockFetch(async (url, init) => {
            if (init?.method && init.method !== "GET") { mutations++; throw Error("MUTATION_FORBIDDEN"); }
            reads++;
            const response = await f.fetchFn(url, init);
            if ((timing === "first" && reads === 1) || (timing === "last" && (op === "init" ? reads === 3 : String(url).endsWith(`/tx/${f.state.tip!.txid}/hex`)))) {
              killVault(root); injected = true;
            }
            return response;
          });
          const signing = spyOn(Transaction.prototype, "sign");
          try {
            await expect(invoke(op, root, fetchFn)).rejects.toThrow(/STOP_SPENDING/);
            expect(injected).toBe(true);
            expect(signing).not.toHaveBeenCalled();
            expect(mutations).toBe(0);
          } finally { signing.mockRestore(); }
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
  for (const op of ["grant", "revoke"] as const) {
    test(`${op}: closed door rejected before decryption`, async () => {
      const root = tmp();
      try {
        const f = fundedVault(root);
        await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
        const door = loadOspDoor(root, "bench");
        writeFileSync(join(vaultPaths(root).ospDoors, "bench.json"), JSON.stringify({ ...door, status: "closed", tip: null }));
        writeFileSync(vaultPaths(root).wrap, "invalid AES key");
        await expect(invoke(op, root, mockFetch(async () => { throw Error("NETWORK_FORBIDDEN"); }))).rejects.toThrow(/closed/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  for (const invalid of ["session", "tip-payment", "change-payment", "brc181", "payment-cap"] as const) {
    test(`grant: ${invalid} rejected before decryption`, async () => {
      const root = tmp();
      try {
        const f = fundedVault(root);
        await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
        writeFileSync(vaultPaths(root).wrap, "invalid AES key");
        const extra: { sessionPubHex?: string; scopeCanonical?: string } = {};
        if (invalid === "session") extra.sessionPubHex = "02" + "ff".repeat(32);
        else extra.scopeCanonical = paidScope(invalid === "tip-payment" ? f.tipScript : invalid === "change-payment" ? f.vaultScript : new P2PKH().lock(PrivateKey.fromHex("02").toAddress()).toHex());
        if (invalid === "brc181") writeFileSync(vaultPaths(root).brc181, "{}");
        if (invalid === "payment-cap") writeFileSync(vaultPaths(root).policy, JSON.stringify({ osp: { maxSatsPerTx: 5, maxSatsPerDay: null } }));
        await expect(invoke("grant", root, mockFetch(async () => { throw Error("NETWORK_FORBIDDEN"); }), extra)).rejects.toThrow(invalid === "session" ? /OSP-0002/ : invalid === "brc181" ? /BRC|policy|envelope/i : invalid === "payment-cap" ? /maxSatsPerTx/ : /ambiguity/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test("revoke remains allowed with ordinary deny-all and malformed paid-grant BRC policy", async () => {
    const root = tmp();
    try {
      const f = fundedVault(root);
      await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      writeFileSync(vaultPaths(root).brc181, "{}");
      const signing = spyOn(Transaction.prototype, "sign");
      try {
        await revokeOspDoor({ root, door: "bench", fetchFn: f.fetchFn });
        expect(signing).toHaveBeenCalledTimes(1);
        expect(loadOspDoor(root, "bench").status).toBe("closed");
        expect(inspectPaymentHold(root).blocked).toBe(false);
      } finally { signing.mockRestore(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("osp CLI", () => {
  const cli = new URL("./cli.ts", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  function run(root: string, args: string[]) {
    return Bun.spawnSync([process.execPath, cli, ...args], {
      env: {
        PATH: process.env.PATH!,
        SystemRoot: process.env.SystemRoot!,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        TMPDIR: tmpdir(),
        DOGFOOD_WALLET_DIR: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("osp address/list on an empty vault; --pay composes door-compatible payment terms", () => {
    const root = tmp();
    try {
      initVault(root);
      const addr = run(root, ["osp", "address"]);
      expect(addr.exitCode).toBe(0);
      const { ospOwnerAddress } = JSON.parse(addr.stdout.toString());
      expect(ospOwnerAddress).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{25,33}$/);
      expect(JSON.parse(run(root, ["osp", "list"]).stdout.toString())).toEqual([]);

      // --pay must embed {amount_sats, script} — never an address — into the canonical blob
      const payee = PrivateKey.fromRandom().toAddress();
      const filed = run(root, [
        "osp", "grant", "--door", "bench", "--request",
        "--scope", '{"allow":["read:users"],"salt":"' + "ab".repeat(16) + '"}',
        "--pay", "10", "--payee", payee,
      ]);
      expect(filed.exitCode).toBe(0);
      const { request } = JSON.parse(filed.stdout.toString());
      expect(request.kind).toBe("osp-grant");
      expect(request.scopeCanonical).toBe(
        `{"allow":["read:users"],"payment":{"amount_sats":10,"script":"${new P2PKH().lock(payee).toHex()}"},"salt":"${"ab".repeat(16)}"}`,
      );
      // conflicts and junk never file
      expect(run(root, ["osp", "grant", "--door", "bench", "--scope", '{"allow":[]}']).exitCode).toBe(1);
      expect(run(root, ["osp", "grant", "--door", "bench", "--scope", "{}", "--pay", "10"]).exitCode).toBe(1);
      expect(run(root, ["osp", "grant", "--door", "bench", "--scope", "{}", "--pay", "10", "--payee", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"]).exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
