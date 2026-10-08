#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultFetchUtxos, sendPayment } from "./send";
import { decideX402, decodeChallengeHeader, buildProof, encodeProofHeader, inspectProof } from "./x402";
import { settleX402 } from "./delegator";
import { defaultVaultDir, killVault, loadUsage, loadVault, statusVault, vaultPaths } from "./vault";
import { loadPolicyEnvelope } from "./brc181";
import { appendFileSync } from "node:fs";

function text(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
    isError,
  };
}

export function createServer(root: string) {
  const server = new McpServer({ name: "dogfood-wallet", version: "0.1.0" });

  server.registerTool(
    "address",
    { description: "Receive address for this Dogfood Wallet vault. Fund this. Never a private key." },
    async () => text({ address: loadVault(root).address }),
  );

  server.registerTool(
    "status",
    { description: "Vault status: address, per-tx/daily/lifetime caps, allowlist, spend usage, killfile. No secrets. Cannot change the allowlist." },
    async () => text(statusVault(root)),
  );

  server.registerTool(
    "balance",
    { description: "On-chain satoshi balance and current spend policy." },
    async () => {
      const v = loadVault(root);
      const utxos = await defaultFetchUtxos(v.address);
      const sats = utxos.reduce((s, u) => s + u.value, 0);
      return text({
        address: v.address,
        balanceSats: sats,
        utxos: utxos.length,
        capSatsPerTx: v.policy.maxSatsPerTx,
        maxSatsPerDay: v.policy.maxSatsPerDay,
        maxSatsLifetime: v.policy.maxSatsLifetime,
        allowlist: v.policy.allowlist,
        killfile: v.policy.killfileOn,
      });
    },
  );

  server.registerTool(
    "send",
    {
      description:
        "Pay satoshis to a mainnet P2PKH address. Rejected if over per-tx/daily/lifetime caps, not on the allowlist, killfile is on, or funds are insufficient. Amount is satoshis, not USD. The agent cannot expand the allowlist.",
      inputSchema: {
        to: z.string().describe("Mainnet P2PKH address"),
        amount: z.number().int().positive().describe("Satoshis to send"),
        note: z.string().optional().describe("Local log note only"),
      },
    },
    async ({ to, amount, note }) => {
      const result = await sendPayment({ root, to, amount, note });
      return text(result, !result.ok);
    },
  );

  server.registerTool(
    "kill",
    { description: "Freeze spending. A human must delete STOP_SPENDING in the vault dir to resume. Agents must not delete it." },
    async () => {
      killVault(root);
      return text({ killed: true, message: "STOP_SPENDING set." });
    },
  );

  server.registerTool(
    "x402_inspect",
    {
      description:
        "Decode a Merkle Works x402 v1 X402-Challenge header and run Dogfood policy (caps, allowlist, kill, expiry). Does not settle or broadcast. The nonce UTXO spend is not implemented.",
      inputSchema: {
        challenge: z.string().describe("X402-Challenge header value (base64url JSON)"),
      },
    },
    async ({ challenge }) => {
      const vault = loadVault(root);
      const result = decideX402(vault.policy, loadUsage(root), decodeChallengeHeader(challenge));
      return text(result, !result.ok);
    },
  );

  server.registerTool(
    "x402_proof",
    {
      description:
        "Build an X402-Proof header from a challenge and a raw settlement tx hex. Does not spend or broadcast. Nonce-UTXO construction still needs the merchant delegator.",
      inputSchema: {
        challenge: z.string().describe("X402-Challenge header value (base64url JSON)"),
        rawtx_hex: z.string().describe("Raw settlement transaction hex"),
        method: z.string().optional().describe("HTTP method of the paid request"),
        path: z.string().optional().describe("HTTP path of the paid request"),
      },
    },
    async ({ challenge, rawtx_hex, method, path }) => {
      const decoded = decodeChallengeHeader(challenge);
      const proof = buildProof({
        challenge: decoded,
        rawtxHex: rawtx_hex,
        method: method || decoded.method || "GET",
        path: path || decoded.path || "/",
        query: decoded.query,
      });
      const check = inspectProof(proof, { challenge: decoded, requestPath: proof.request.path });
      if (!check.ok) return text(check, true);
      return text({ header: encodeProofHeader(proof), proof, txid: proof.payment.txid });
    },
  );

  server.registerTool(
    "x402_delegate",
    {
      description:
        "Ask the configured Merkle Works delegator (DOGFOOD_X402_DELEGATOR_URL) to complete a 402 settlement tx, then return X402-Proof. Policy-gated. Default mode follows the frozen v1 demo model (gateway sponsors the settlement from its pool; vaultPaid=false). Pass vault_fund=true to pay from vault coins instead. Broadcast is off unless broadcast=true or DOGFOOD_X402_BROADCAST=1; broadcasts use ARC with a WoC fallback on fee-policy rejections.",
      inputSchema: {
        challenge: z.string().describe("X402-Challenge header value (base64url JSON)"),
        method: z.string().optional().describe("HTTP method of the paid request"),
        path: z.string().optional().describe("HTTP path of the paid request"),
        broadcast: z.boolean().optional().describe("If true, submit the completed tx. Default off."),
        vault_fund: z.boolean().optional().describe("If true, fund the payment from vault coins (0xC1 signed input + change). Default off."),
      },
    },
    async ({ challenge, method, path, broadcast, vault_fund }) => {
      const vault = loadVault(root);
      const decoded = decodeChallengeHeader(challenge);
      const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
      if (!loaded.ok) return text(loaded, true);
      const result = await settleX402({
        policy: vault.policy,
        usage: loadUsage(root),
        challenge: decoded,
        method,
        path,
        broadcast,
        envelope: loaded.envelope,
        fund: vault_fund ? { key: vault.key, address: vault.address } : undefined,
        onSpend: (entry) => appendFileSync(vaultPaths(root).log, `${JSON.stringify(entry)}\n`),
      });
      return text(result, !result.ok);
    },
  );

  return server;
}

export async function runMcp(root = defaultVaultDir()) {
  const server = createServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  runMcp().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
