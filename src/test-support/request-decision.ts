// Isolated synthetic signer: no keys, chain access or network mutations.
import { mock } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockFetch } from "./fetch";
const [root, id, mode] = process.argv.slice(2) as [string, string, string];
globalThis.fetch = mockFetch(async () => { throw new Error("Network forbidden"); });
mock.module("../osp", () => ({
  async signOspGrant() {
    appendFileSync(join(root, "signer-calls"), "sign\n");
    writeFileSync(join(root, "entered"), "yes");
    if (mode === "wait") {
      while (!existsSync(join(root, "release"))) await Bun.sleep(10);
    }
    if (mode === "ambiguous") throw new Error("synthetic lost broadcast response");
    if (mode === "crash") process.exit(23); // signer finished, request not committed
    if (mode === "write-failure") {
      const path = join(root, "requests", `${id}.json`);
      renameSync(path, path + ".saved");
      mkdirSync(path); // force final request rename to fail
    }
    return { txid: "ab".repeat(32), paymentSats: 10, fee: 1 };
  },
}));
const { approveRequest, denyRequest } = await import("../requests");
try {
  const result = mode === "deny" ? denyRequest(root, id) : await approveRequest(root, id);
  console.log(JSON.stringify(result));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
