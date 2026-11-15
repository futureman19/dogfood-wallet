import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveRequest, denyRequest, fileRequest, listRequests } from "./requests";

const ask = { kind: "osp-grant" as const, door: "bench", scopeCanonical: '{"allow":["read"],"salt":"00112233445566778899aabbccddeeff"}' };
const worker = fileURLToPath(new URL("./test-support/request-decision.ts", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "request-decision-"));
  return { root, id: fileRequest(root, ask).request.id };
}
function start(root: string, id: string, mode: string) {
  return Bun.spawn([process.execPath, worker, root, id, mode], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOGFOOD_WALLET_DIR: root, TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir() },
    stdout: "pipe", stderr: "pipe",
  });
}
async function run(root: string, id: string, mode: string) {
  const child = start(root, id, mode);
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, error };
}
function calls(root: string) { return readFileSync(join(root, "signer-calls"), "utf8").trim().split("\n").length; }
async function entered(root: string) {
  for (let i = 0; i < 500; i++) {
    if (existsSync(join(root, "entered"))) return;
    await Bun.sleep(10);
  }
  throw new Error("signer never entered");
}

test("cross-process approval excludes approval and denial until durable completion", async () => {
  const { root, id } = fixture();
  const first = start(root, id, "wait");
  try {
    await entered(root);
    const second = await run(root, id, "success");
    const deny = await run(root, id, "deny");
    expect(second.code).toBe(1);
    expect(second.error).toMatch(/held|unresolved/i);
    expect(deny.code).toBe(1);
    expect(deny.error).toMatch(/held|unresolved/i);
    expect(calls(root)).toBe(1);
    expect(fileRequest(root, ask).created).toBe(false);
    writeFileSync(join(root, "release"), "go");
    expect(await first.exited).toBe(0);
    expect(listRequests(root)[0]!.status).toBe("approved");
    expect((await run(root, id, "success")).code).toBe(1);
    expect(calls(root)).toBe(1);
  } finally {
    first.kill(); await first.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

for (const mode of ["ambiguous", "crash", "write-failure", "killed"]) {
  test(`${mode} retains a per-request hold across fresh processes without payment lock`, async () => {
    const { root, id } = fixture();
    try {
      if (mode === "killed") {
        const child = start(root, id, "wait");
        try { await entered(root); } finally { child.kill(); await child.exited; }
      } else {
        const result = await run(root, id, mode);
        expect(result.code).not.toBe(0);
      }
      if (mode === "write-failure") {
        const path = join(root, "requests", `${id}.json`);
        rmSync(path, { recursive: true });
        renameSync(path + ".saved", path);
      }
      expect(existsSync(join(root, "payment.lock"))).toBe(false);
      expect(listRequests(root)[0]!.status).toBe("pending");
      expect(fileRequest(root, ask).created).toBe(false);
      const retry = await run(root, id, "success");
      const denial = await run(root, id, "deny");
      expect(retry.code).toBe(1);
      expect(retry.error).toMatch(/held|unresolved/i);
      expect(denial.code).toBe(1);
      expect(calls(root)).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20000);
}

for (const content of ["", "not json"]) {
  test(`abandoned ${JSON.stringify(content)} claim blocks both decisions without signer access`, async () => {
    const { root, id } = fixture();
    try {
      writeFileSync(join(root, "requests", `${id}.decision.lock`), content);
      await expect(approveRequest(root, id)).rejects.toThrow(/held|unresolved/i);
      expect(() => denyRequest(root, id)).toThrow(/held|unresolved/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("denial wins before approval and remains terminal", async () => {
  const { root, id } = fixture();
  try {
    expect(denyRequest(root, id).status).toBe("denied");
    expect((await run(root, id, "success")).code).toBe(1);
    expect(existsSync(join(root, "signer-calls"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
