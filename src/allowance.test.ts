import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { LockingScript, PrivateKey } from "@bsv/sdk";
import {
  AGENT_ALLOWANCE_PROTOCOL_ID,
  certificateType,
  generateAllowanceId,
  inspectDescriptor,
  lockingScriptHex,
  parseAllowanceLock,
  revocationScriptHex,
  unlockingAsm,
} from "./allowance";

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
