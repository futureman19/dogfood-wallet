import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Certificate, KeyDeriver, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, VerifiableCertificate } from "@bsv/sdk";
import {
  AGENT_ALLOWANCE_PROTOCOL_ID,
  certificateType,
  deriveAllowanceKeys,
  fundAllowance,
  generateAllowanceId,
  inspectCertificate,
  inspectDescriptor,
  issueAllowanceCertificate,
  proveAllowanceCertificate,
  lockingScriptHex,
  parseAllowanceLock,
  revocationScriptHex,
  sweepAllowance,
  unlockingAsm,
} from "./allowance";
import { initVault, killVault, loadVault } from "./vault";

function compressedPub(): string {
  return PrivateKey.fromRandom().toPublicKey().toString();
}

describe("BRC-0204 constants", () => {
  test("protocol ID is BRC-43 [2, agent allowance]", () => {
    expect(AGENT_ALLOWANCE_PROTOCOL_ID).toEqual([2, "agent allowance"]);
  });

  test("certificate type is base64 SHA-256 of 'agent allowance'", () => {
    const expected = createHash("sha256").update("agent allowance").digest("base64");
    expect(certificateType()).toBe(expected);
  });

  test("allowanceId is ≥16 random bytes, base64, unique", () => {
    const a = generateAllowanceId();
    const b = generateAllowanceId();
    expect(Buffer.from(a, "base64").length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });
});

describe("BRC-0204 Type42 keys", () => {
  test("owner and agent allowance pubs are derived, not identity keys", () => {
    const owner = PrivateKey.fromRandom();
    const agent = PrivateKey.fromRandom();
    const id = generateAllowanceId();
    const keys = deriveAllowanceKeys(owner, agent.toPublicKey().toString(), id);
    expect(keys.ownerPubHex).not.toBe(owner.toPublicKey().toString().toLowerCase());
    expect(keys.agentPubHex).not.toBe(agent.toPublicKey().toString().toLowerCase());
    expect(keys.ownerPriv.toPublicKey().toString().toLowerCase()).toBe(keys.ownerPubHex);
    const agentView = new KeyDeriver(agent).derivePublicKey(
      AGENT_ALLOWANCE_PROTOCOL_ID,
      id,
      owner.toPublicKey().toString(),
      true,
    );
    expect(agentView.toString().toLowerCase()).toBe(keys.agentPubHex);
  });
});

describe("BRC-52 allowance certificate", () => {
  test("owner issues a signed cert bound to the revocation outpoint", async () => {
    const owner = PrivateKey.fromRandom();
    const agent = PrivateKey.fromRandom();
    const id = generateAllowanceId();
    const revocation = `${"ab".repeat(32)}.2`;
    const issued = await issueAllowanceCertificate({
      ownerRoot: owner,
      agentIdentityPubHex: agent.toPublicKey().toString(),
      allowanceId: id,
      purpose: "Competitor research",
      revocationOutpoint: revocation,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.certificate.type).toBe(certificateType());
    expect(issued.certificate.subject.toLowerCase()).toBe(agent.toPublicKey().toString().toLowerCase());
    expect(issued.certificate.certifier.toLowerCase()).toBe(owner.toPublicKey().toString().toLowerCase());
    expect(issued.certificate.revocationOutpoint).toBe(revocation);
    expect(issued.certificate.fields.allowanceId).toBeDefined();
    expect(issued.certificate.signature).toMatch(/^[0-9a-f]+$/i);
    const sdk = Certificate.fromObject(issued.certificate);
    expect(await sdk.verify()).toBe(true);
    const check = await inspectCertificate(issued.certificate, {
      ownerIdentityKey: owner.toPublicKey().toString(),
      agentIdentityKey: agent.toPublicKey().toString(),
      revocationOutpoint: revocation,
    });
    expect(check.ok).toBe(true);
  });

  test("inspect rejects a type that is not agent allowance", async () => {
    const owner = PrivateKey.fromRandom();
    const agent = PrivateKey.fromRandom();
    const issued = await issueAllowanceCertificate({
      ownerRoot: owner,
      agentIdentityPubHex: agent.toPublicKey().toString(),
      allowanceId: generateAllowanceId(),
      purpose: "x",
      revocationOutpoint: `${"cd".repeat(32)}.0`,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const check = await inspectCertificate(
      { ...issued.certificate, type: Buffer.alloc(32, 7).toString("base64") },
      {
        ownerIdentityKey: owner.toPublicKey().toString(),
        agentIdentityKey: agent.toPublicKey().toString(),
        revocationOutpoint: issued.certificate.revocationOutpoint,
      },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("BAD_CERT");
  });

  test("agent proves purpose to a verifier without revealing allowanceId", async () => {
    const owner = PrivateKey.fromRandom();
    const agent = PrivateKey.fromRandom();
    const verifier = PrivateKey.fromRandom();
    const issued = await issueAllowanceCertificate({
      ownerRoot: owner,
      agentIdentityPubHex: agent.toPublicKey().toString(),
      allowanceId: generateAllowanceId(),
      purpose: "Competitor research",
      revocationOutpoint: `${"ee".repeat(32)}.1`,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const proved = await proveAllowanceCertificate({
      certificate: issued.certificate,
      masterKeyring: issued.masterKeyring,
      agentWallet: new ProtoWallet(agent),
      verifierPubHex: verifier.toPublicKey().toString(),
      fieldsToReveal: ["purpose"],
    });
    expect(proved.ok).toBe(true);
    if (!proved.ok) return;
    expect(JSON.stringify(proved)).not.toMatch(/\b5[HJK][1-9A-HJ-NP-Za-km-z]{50,}\b/);
    const verifiable = VerifiableCertificate.fromCertificate(proved.certificate, proved.keyring);
    const opened = await verifiable.decryptFields(new ProtoWallet(verifier));
    expect(opened.purpose).toBe("Competitor research");
    expect(opened.allowanceId).toBeUndefined();
  });

  test("prove refuses a field that is not on the cert", async () => {
    const owner = PrivateKey.fromRandom();
    const agent = PrivateKey.fromRandom();
    const issued = await issueAllowanceCertificate({
      ownerRoot: owner,
      agentIdentityPubHex: agent.toPublicKey().toString(),
      allowanceId: generateAllowanceId(),
      purpose: "x",
      revocationOutpoint: `${"ff".repeat(32)}.0`,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const proved = await proveAllowanceCertificate({
      certificate: issued.certificate,
      masterKeyring: issued.masterKeyring,
      agentWallet: new ProtoWallet(agent),
      verifierPubHex: PrivateKey.fromRandom().toPublicKey().toString(),
      fieldsToReveal: ["notAField"],
    });
    expect(proved.ok).toBe(false);
    if (!proved.ok) expect(proved.code).toBe("BAD_REVEAL");
  });
});

describe("BRC-0204 locking script", () => {
  test("OP_IF agent CHECKSIG OP_ELSE owner CHECKSIG OP_ENDIF", () => {
    const agent = compressedPub();
    const owner = compressedPub();
    const hex = lockingScriptHex(agent, owner);
    const asm = LockingScript.fromHex(hex).toASM();
    expect(asm).toBe(`OP_IF ${agent} OP_CHECKSIG OP_ELSE ${owner} OP_CHECKSIG OP_ENDIF`);
    const parsed = parseAllowanceLock(hex);
    expect(parsed).toEqual({ ok: true, agentPubHex: agent.toLowerCase(), ownerPubHex: owner.toLowerCase() });
  });

  test("revocation is owner CHECKSIG only", () => {
    const owner = compressedPub();
    const hex = revocationScriptHex(owner);
    expect(LockingScript.fromHex(hex).toASM()).toBe(`${owner} OP_CHECKSIG`);
  });

  test("agent unlock ends OP_1, owner unlock ends OP_0", () => {
    expect(unlockingAsm("agent", "aa")).toBe("aa OP_1");
    expect(unlockingAsm("owner", "bb")).toBe("bb OP_0");
  });

  test("rejects a P2PKH lock", () => {
    const p2pkh = "76a914" + "11".repeat(20) + "88ac";
    expect(parseAllowanceLock(p2pkh).ok).toBe(false);
  });
});

describe("BRC-0204 descriptor inspect", () => {
  const agent = compressedPub();
  const owner = compressedPub();
  const id = generateAllowanceId();
  const ok = {
    version: "1.0",
    allowanceId: id,
    purpose: "Competitor research",
    ownerIdentityKey: owner,
    agentIdentityKey: agent,
    protocolID: [2, "agent allowance"],
    outputs: [
      { outpoint: "aa".repeat(32) + ".0", satoshis: 12500 },
      { outpoint: "aa".repeat(32) + ".1", satoshis: 12500 },
    ],
    revocationOutpoint: "aa".repeat(32) + ".2",
  };

  test("accepts a v1.0 descriptor", () => {
    const r = inspectDescriptor(ok);
    expect(r).toMatchObject({ ok: true, totalSats: 25000, outputCount: 2 });
  });

  test("rejects wrong version", () => {
    const r = inspectDescriptor({ ...ok, version: "2.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_VERSION");
  });

  test("rejects short allowanceId", () => {
    const r = inspectDescriptor({ ...ok, allowanceId: Buffer.from("short").toString("base64") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_ID");
  });

  test("rejects wrong protocolID", () => {
    const r = inspectDescriptor({ ...ok, protocolID: [2, "something else"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_PROTOCOL");
  });

  test("rejects missing revocation", () => {
    const { revocationOutpoint: _, ...rest } = ok;
    const r = inspectDescriptor(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_REVOCATION");
  });

  test("rejects empty outputs", () => {
    const r = inspectDescriptor({ ...ok, outputs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_OUTPUTS");
  });
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-allowance-"));
}

function vaultCoin(address: string, satoshis: number) {
  const tx = new Transaction();
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(address) });
  return { txid: tx.id("hex") as string, hex: tx.toHex(), satoshis };
}

describe("fundAllowance", () => {
  test("does not fetch UTXOs when killfile is on", async () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      let fetched = false;
      const result = await fundAllowance({
        root,
        agentPubHex: compressedPub(),
        amount: 1000,
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

  test("fetches even when allowlist is empty, then INSUFFICIENT", async () => {
    const root = scratch();
    try {
      initVault(root);
      let fetched = false;
      const result = await fundAllowance({
        root,
        agentPubHex: compressedPub(),
        amount: 1000,
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

  test("broadcasts two allowance outputs plus a 1-sat revocation", async () => {
    const root = scratch();
    try {
      initVault(root);
      const vault = loadVault(root);
      const agent = compressedPub();
      const coin = vaultCoin(vault.address, 50_000);
      let raw = "";
      const result = await fundAllowance({
        root,
        agentPubHex: agent,
        amount: 4000,
        pieces: 2,
        fetchUtxos: async () => [{ tx_hash: coin.txid, tx_pos: 0, value: coin.satoshis }],
        fetchTxHex: async () => coin.hex,
        broadcast: async (hex) => {
          raw = hex;
          return { txid: Transaction.fromHex(hex).id("hex") as string };
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const funded = Transaction.fromHex(raw);
      const saved = JSON.parse(readFileSync(join(root, "allowance.json"), "utf8"));
      const keys = deriveAllowanceKeys(vault.key, agent, saved.allowanceId);
      const lock = lockingScriptHex(keys.agentPubHex, keys.ownerPubHex);
      const rev = revocationScriptHex(keys.ownerPubHex);
      expect(lock).not.toBe(lockingScriptHex(agent, vault.key.toPublicKey().toString()));
      expect(funded.outputs[0].lockingScript.toHex()).toBe(lock);
      expect(funded.outputs[1].lockingScript.toHex()).toBe(lock);
      expect(funded.outputs[2].lockingScript.toHex()).toBe(rev);
      expect(funded.outputs[0].satoshis).toBe(2000);
      expect(funded.outputs[1].satoshis).toBe(2000);
      expect(funded.outputs[2].satoshis).toBe(1);
      const inspected = inspectDescriptor(saved);
      expect(inspected.ok).toBe(true);
      if (inspected.ok) {
        expect(inspected.totalSats).toBe(4000);
        expect(inspected.ownerIdentityKey).toBe(vault.key.toPublicKey().toString().toLowerCase());
        expect(inspected.agentIdentityKey).toBe(agent.toLowerCase());
      }
      expect(saved.certificate).toBeDefined();
      const certCheck = await inspectCertificate(saved.certificate, {
        ownerIdentityKey: vault.key.toPublicKey().toString(),
        agentIdentityKey: agent,
        revocationOutpoint: saved.revocationOutpoint,
      });
      expect(certCheck.ok).toBe(true);
      expect(saved.masterKeyring).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepAllowance", () => {
  test("owner branch OP_0 even when killfile is on", async () => {
    const root = scratch();
    try {
      initVault(root);
      const vault = loadVault(root);
      const agent = compressedPub();
      const coin = vaultCoin(vault.address, 50_000);
      const funded = await fundAllowance({
        root,
        agentPubHex: agent,
        amount: 3000,
        fetchUtxos: async () => [{ tx_hash: coin.txid, tx_pos: 0, value: coin.satoshis }],
        fetchTxHex: async () => coin.hex,
        broadcast: async (hex) => ({ txid: Transaction.fromHex(hex).id("hex") as string }),
      });
      expect(funded.ok).toBe(true);
      if (!funded.ok) return;
      killVault(root);
      let sweepRaw = "";
      const result = await sweepAllowance({
        root,
        fetchTxHex: async (txid) => {
          if (txid === coin.txid) return coin.hex;
          return funded.rawHex;
        },
        broadcast: async (hex) => {
          sweepRaw = hex;
          return { txid: Transaction.fromHex(hex).id("hex") as string };
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sweep = Transaction.fromHex(sweepRaw);
      expect(sweep.inputs[0].unlockingScript.toASM().endsWith("OP_0")).toBe(true);
      expect(sweep.inputs[1].unlockingScript.toASM().endsWith("OP_0")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
