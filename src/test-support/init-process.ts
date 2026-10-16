// Isolated filesystem fault injection; never imported by production.
import * as fs from "node:fs";
import { mock } from "bun:test";
import { join } from "node:path";
const [root, control, label, mode = "race", target = ""] = process.argv.slice(2) as string[];
const original = { ...fs };
const fds = new Map<number, string>();
function boundary(name: string) {
  if (name !== target) return;
  if (mode === "die") process.exit(71);
  throw new Error("INJECTED_PRIVATE_SENTINEL");
}
mock.module("node:fs", () => ({
  ...original,
  mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
    if (args[0] === root && mode === "race") {
      original.writeFileSync(join(control!, `${label}.ready`), "ready");
      const deadline = Date.now() + 10000;
      while (!original.existsSync(join(control!, `${label}.go`))) {
        if (Date.now() > deadline) throw new Error("barrier timeout");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const result = original.mkdirSync(...args);
    if (String(args[0]) === join(root!, ".init")) {
      boundary("locked");
      if (mode === "hold") {
        original.writeFileSync(join(control!, `${label}.ready`), "ready");
        const deadline = Date.now() + 10000;
        while (!original.existsSync(join(control!, `${label}.go`))) {
          if (Date.now() > deadline) throw new Error("barrier timeout");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    }
    return result;
  },
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (path === join(root!, ".init", "ready")) boundary("before-complete");
    const fd = original.openSync(...args);
    fds.set(fd, path);
    if (path === join(root!, ".init", "ready")) boundary("empty-complete");
    return fd;
  },
  fsyncSync: (fd: number) => {
    const path = fds.get(fd);
    if (path) boundary(`flush-${path.endsWith("ready") ? "complete" : path.split(/[\\/]/).pop()}`);
    original.fsyncSync(fd);
    for (const file of ["wrap.key", "wif.enc", "address.txt", "policy.json", "complete"]) {
      if (path === join(root!, ".init", file === "complete" ? "ready" : file)) boundary(`synced-${file}`);
    }
  },
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (target === "partial-write" && typeof args[0] === "number" && fds.get(args[0]) === join(root!, ".init", "wif.enc")) {
      original.writeFileSync(args[0], "partial");
      boundary("partial-write");
    }
    return original.writeFileSync(...args);
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    boundary("link-failure");
    if (target === "link-collision" && String(args[1]) === join(root!, "wif.enc")) {
      original.writeFileSync(args[1], "preserve-existing", { flag: "wx" });
    }
    const result = original.linkSync(...args);
    boundary(`published-${String(args[1]).split(/[\\/]/).pop()}`);
    if (target === "corrupt-address" && String(args[1]) === join(root!, "policy.json")) {
      original.writeFileSync(join(root!, "address.txt"), "INJECTED_PRIVATE_SENTINEL");
    }
    return result;
  },
}));
globalThis.fetch = Object.assign(() => { throw new Error("NETWORK_FORBIDDEN"); }, {
  preconnect() { throw new Error("NETWORK_FORBIDDEN"); },
}) as typeof fetch;
const { initVault } = await import("../vault");
try { console.log(JSON.stringify({ ok: true, ...initVault(root!) })); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })); }
