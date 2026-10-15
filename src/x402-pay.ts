import { appendFileSync, readFileSync } from "node:fs";
import { loadVault, loadUsage, vaultPaths } from "./vault";
import { loadPolicyEnvelope } from "./brc181";

/** Shared CLI/MCP rail order. Only a typed UNSUPPORTED advances currencies. */
export async function payX402(root: string, url: string) {
  const vault = loadVault(root);
  const { settleBsvX402, BsvX402Error } = await import("./bsv-x402");
  // Recent own sends, so the client can mask WoC's confirmed-only unspent view.
  const ownSpendTxids: string[] = [];
  try {
    const lines = readFileSync(vaultPaths(root).log, "utf8").trim().split("\n");
    for (const line of lines.slice(-200)) {
      try {
        const row = JSON.parse(line) as { kind?: string; asset?: string; txid?: unknown };
        if (row.kind === "send" && row.asset === "bsv" && typeof row.txid === "string") ownSpendTxids.push(row.txid);
      } catch { /* ignore torn lines */ }
    }
  } catch { /* no log yet */ }
  try {
    const r = await settleBsvX402({
      url,
      key: vault.key,
      from: vault.address,
      policy: vault.policy,
      usage: loadUsage(root, new Date(), "bsv"),
      ownSpendTxids: ownSpendTxids.slice(-10),
      // Load the signed BSV policy only if a BSV requirement is offered.
      get policyEnvelope() {
        const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
        if (!loaded.ok) throw new BsvX402Error(loaded.code, loaded.message);
        return loaded.envelope;
      },
      onSpend: (row) => appendFileSync(vaultPaths(root).log, JSON.stringify(row) + "\n"),
    });
    return r;
  } catch (e) {
    // Policy, funding, and settlement failures never switch currencies.
    if (!(e instanceof BsvX402Error) || e.code !== "UNSUPPORTED") throw e;
  }
  const { deriveEvmAddress } = await import("./evm");
  const { settleUsdcX402, UsdcX402Error } = await import("./evm-x402");
  try {
    const r = await settleUsdcX402({
      url,
      key: vault.key,
      from: deriveEvmAddress(vault.key),
      pocket: vault.policy.evm?.usdc,
      killfileOn: vault.policy.killfileOn,
      usage: loadUsage(root, new Date(), "usdc-base"),
      onSpend: (row) => appendFileSync(vaultPaths(root).log, JSON.stringify(row) + "\n"),
    });
    return r;
  } catch (e) {
    // No base/USDC requirement offered? Try the Solana pocket before failing.
    if (!(e instanceof UsdcX402Error) || e.code !== "UNSUPPORTED") throw e;
    const { deriveSolanaAddress } = await import("./solana");
    const { settleSolanaX402 } = await import("./solana-x402");
    const r = await settleSolanaX402({
      url,
      key: vault.key,
      from: deriveSolanaAddress(vault.key),
      pocket: vault.policy.solana?.usdc,
      killfileOn: vault.policy.killfileOn,
      usage: loadUsage(root, new Date(), "usdc-solana"),
      onSpend: (row) => appendFileSync(vaultPaths(root).log, JSON.stringify(row) + "\n"),
    });
    return r;
  }
}
