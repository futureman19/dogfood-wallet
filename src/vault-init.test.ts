import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initVault, loadVault } from "./vault";

const files = ["wrap.key", "wif.enc", "address.txt", "policy.json"];
function fixture() { return mkdtempSync(join(tmpdir(), "dogfood-init-")); }
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name);
    if (statSync(path).isFile()) result[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return result;
}
function child(root: string, control: string, label: string, mode = "race", target = "") {
  return Bun.spawn([process.execPath, join(import.meta.dir, "test-support/init-process.ts"), root, control, label, mode, target], { stdout: "pipe", stderr: "pipe" });
}
async function waitFor(path: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("fixture readiness timeout");
    await Bun.sleep(10);
  }
}
test("synchronized processes cannot both initialize or replace the returned key", async () => {
  const control = fixture(), root = join(control, "vault");
  const a = child(root, control, "a"), b = child(root, control, "b");
  try {
    await Promise.all([waitFor(join(control, "a.ready")), waitFor(join(control, "b.ready"))]);
    writeFileSync(join(control, "a.go"), "go");
    const first = JSON.parse(await new Response(a.stdout).text());
    expect(await a.exited).toBe(0);
    expect(first.ok).toBe(true);
    const before = snapshot(root);
    writeFileSync(join(control, "b.go"), "go");
    const second = JSON.parse(await new Response(b.stdout).text());
    expect(await b.exited).toBe(0);
    expect(second.ok).toBe(false);
    expect(snapshot(root)).toEqual(before);
    expect(loadVault(root).address).toBe(first.address);
  } finally {
    a.kill(); b.kill(); await Promise.all([a.exited, b.exited]);
    rmSync(control, { recursive: true, force: true });
  }
}, 20000);

test("a live exclusive initializer blocks a contender and readers without waiting", async () => {
  const control = fixture(), root = join(control, "vault");
  const a = child(root, control, "a", "hold");
  try {
    await waitFor(join(control, "a.ready"));
    expect(() => { loadVault(root); }).toThrow(/initialization/i);
    const b = child(root, control, "b", "normal");
    try {
      const output = await new Response(b.stdout).text();
      expect(await b.exited).toBe(0);
      expect(JSON.parse(output).ok).toBe(false);
    } finally { b.kill(); await b.exited; }
    writeFileSync(join(control, "a.go"), "go");
    const result = JSON.parse(await new Response(a.stdout).text());
    expect(await a.exited).toBe(0);
    expect(result.ok).toBe(true);
    expect(loadVault(root).address).toBe(result.address);
  } finally { a.kill(); await a.exited; rmSync(control, { recursive: true, force: true }); }
}, 20000);

for (const name of [...files, "STOP_SPENDING", "spends.jsonl", "unexpected", ".init"]) {
  test(`pre-existing ${name} is preserved and refuses initialization`, () => {
    const root = fixture();
    try {
      if (name === ".init") mkdirSync(join(root, name));
      else writeFileSync(join(root, name), "private-existing-sentinel");
      const before = snapshot(root);
      expect(() => initVault(root)).toThrow();
      expect(snapshot(root)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const boundaries = ["locked", "partial-write", "link-failure", ...files.map(f => `flush-${f}`), ...files.map(f => `synced-${f}`), ...files.map(f => `published-${f}`), "before-complete", "empty-complete"];
for (const mode of ["fail", "die"]) for (const boundary of boundaries) {
  test(`${mode} at ${boundary} retains evidence and blocks reload/reinit`, async () => {
    const control = fixture(), root = join(control, "vault");
    const p = child(root, control, "fault", mode, boundary);
    try {
      const output = await new Response(p.stdout).text();
      expect(await p.exited).toBe(mode === "die" ? 71 : 0);
      if (mode === "fail") {
        expect(JSON.parse(output).ok).toBe(false);
        expect(output.includes("INJECTED_PRIVATE_SENTINEL")).toBe(false);
      }
      expect(existsSync(join(root, ".init"))).toBe(true);
      expect(() => { loadVault(root); }).toThrow(/initialization/i);
      const before = snapshot(root);
      expect(() => initVault(root)).toThrow();
      expect(snapshot(root)).toEqual(before);
    } finally { p.kill(); await p.exited; rmSync(control, { recursive: true, force: true }); }
  });
}
for (const boundary of ["synced-complete", "flush-complete", "published-complete", "corrupt-address", "link-collision"]) {
  test(`${boundary} never returns an unvalidated address`, async () => {
    const control = fixture(), root = join(control, "vault");
    const p = child(root, control, "fault", "fail", boundary);
    try {
      const output = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      expect(JSON.parse(output).ok).toBe(false);
      expect(output.includes("INJECTED_PRIVATE_SENTINEL")).toBe(false);
      if (boundary === "published-complete") expect(loadVault(root).key.toAddress()).toBe(loadVault(root).address);
      else expect(() => { loadVault(root); }).toThrow(/initialization/i);
      if (boundary === "link-collision") expect(readFileSync(join(root, "wif.enc"), "utf8")).toBe("preserve-existing");
      const before = snapshot(root);
      expect(() => initVault(root)).toThrow();
      expect(snapshot(root)).toEqual(before);
    } finally { p.kill(); await p.exited; rmSync(control, { recursive: true, force: true }); }
  });
}
test("complete reload, legacy compatibility, private modes and no secret response fields", () => {
  const control = fixture(), root = join(control, "vault");
  try {
    const result = initVault(root, 1234);
    expect(Object.keys(result)).toEqual(["address"]);
    expect(loadVault(root).address).toBe(result.address);
    expect(loadVault(root).policy.maxSatsPerTx).toBe(1234);
    expect(readFileSync(join(root, ".init", "complete"), "utf8")).toBe("complete\n");
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, ".init")).mode & 0o777).toBe(0o700);
      for (const file of files) expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
    }
    const before = snapshot(root);
    expect(() => initVault(root)).toThrow(/already initialized/i);
    expect(snapshot(root)).toEqual(before);
    // Only this never-funded fixture simulates the legacy layout.
    rmSync(join(root, ".init"), { recursive: true });
    expect(loadVault(root).address).toBe(result.address);
  } finally { rmSync(control, { recursive: true, force: true }); }
});
