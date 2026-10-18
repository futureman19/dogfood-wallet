// Read-only reference input; run: bun scripts/gryd-agent-vectors.ts <grid-repo-root>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { BSM, PrivateKey, Utils } from "@bsv/sdk";
const root = process.argv[2];
if (!root) throw new Error("Pass the read-only Gryd source root");
const sourcePath = "packages/locus-protocol/src/signed-write.ts";
const source = readFileSync(join(root, sourcePath));
const protocol = await import(pathToFileURL(resolve(root, sourcePath)).href);
// Public synthetic scalar 1, never a vault identity.
const key = PrivateKey.fromHex("1".padStart(64, "0"));
const inputs = [
  { action: "agent.mine", method: "POST", path: "/api/v1/agents/mine", body: {}, network: "mainnet", audience: "the-grid-api.fly.dev" },
  { action: "agent.update", method: "PUT", path: "/api/v1/agents/a%2Fb", body: { z: null, name: "Café 🌍\n\"hi\"", nested: { z: [true, false, null, -0, 1e-7], a: { "10": 10, "2": 2 } } }, network: "mainnet", audience: "the-grid-api.fly.dev" },
  { action: "agent.action.dry_run", method: "POST", path: "/api/v1/agents/a/actions/dry-run", body: { requestId: "fixture", action: "area.sense", target: { lng: -122.4, lat: 37.7, radiusM: 100 }, params: {} }, network: "mainnet", audience: "the-grid-api.fly.dev" },
  { action: "agent.schedule.delete", method: "DELETE", path: "/api/v1/agents/a/schedules/s", body: {}, network: "testnet", audience: "locus-api.test" },
];
const vectors = inputs.map(input => {
  const payload = { mode: "signed_write", ...input, timestamp: 1700000000, nonce: "00000000-0000-4000-8000-000000000001" };
  const message = protocol.canonicalSignedWriteMessage(payload);
  return { payload, message, utf8Hex: Buffer.from(message).toString("hex"), signature: BSM.sign(Utils.toArray(message, "utf8"), key, "base64"), pubkey: key.toPublicKey().toString(), address: key.toAddress() };
});
const output = { sourcePath, sourceSha256: createHash("sha256").update(source).digest("hex"), agentActions: protocol.SIGNED_WRITE_ACTIONS.filter((a: string) => a.startsWith("agent.")), vectors };
writeFileSync(new URL("../testdata/gryd-agent-vectors.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(`Generated ${vectors.length} protocol-derived vectors`);
