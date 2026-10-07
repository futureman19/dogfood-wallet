#!/usr/bin/env bun
import { defaultFetchUtxos } from "./send";
import { sendPayment, sweepPayment, splitPayment } from "./send";
import { decideX402, decodeChallengeHeader } from "./x402";
import { allowDestination, defaultVaultDir, initVault, killVault, loadUsage, loadVault, statusVault } from "./vault";

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

const HELP = `Dogfood Wallet — local BSV agent vault (mainnet)

  bun src/cli.ts init
  bun src/cli.ts address
  bun src/cli.ts balance
  bun src/cli.ts status
  bun src/cli.ts allow <p2pkh-address>
  bun src/cli.ts send <to-address> <sats> [note]
  bun src/cli.ts kill
  bun src/cli.ts sweep <p2pkh-address>
  bun src/cli.ts split [piece-sats]
  bun src/cli.ts x402-inspect <X402-Challenge-header>
  bun src/cli.ts mcp
  bun src/cli.ts mcp-http

The LLM never sees the key. Policy lives in the signer.
allow, sweep, and split are human-only (not MCP tools).
Vault dir: $DOGFOOD_WALLET_DIR or ~/.dogfood-wallet
`;

async function cmdBalance(root: string) {
  const v = loadVault(root);
  const utxos = await defaultFetchUtxos(v.address);
  const sats = utxos.reduce((s, u) => s + u.value, 0);
  console.log(`Address: ${v.address}`);
  console.log(`Balance: ${sats} sats (${utxos.length} UTXOs)`);
  console.log(`Cap: ${v.policy.maxSatsPerTx} sats/tx`);
  console.log(`Daily: ${v.policy.maxSatsPerDay ?? "none"}`);
  console.log(`Allowlist: ${v.policy.allowlist === null ? "unrestricted" : v.policy.allowlist.length === 0 ? "(empty)" : v.policy.allowlist.join(", ")}`);
  console.log(`Killfile: ${v.policy.killfileOn ? "ON (STOP_SPENDING)" : "off"}`);
}

async function main() {
  const root = defaultVaultDir();
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case "init": {
      const { address } = initVault(root);
      console.log("Initialized.");
      console.log(`Address: ${address}`);
      console.log(`Vault: ${root}`);
      console.log("Fund this address. Do not print or copy the key.");
      console.log("Allowlist is empty. Human next: bun src/cli.ts allow <p2pkh-address>");
      break;
    }
    case "address":
      console.log(loadVault(root).address);
      break;
    case "balance":
      await cmdBalance(root);
      break;
    case "status": {
      const s = statusVault(root);
      console.log(`Root: ${s.root}`);
      console.log(`Address: ${s.address || "(not initialized)"}`);
      console.log(`Network: ${s.network}`);
      console.log(`Cap: ${s.cap} sats/tx`);
      console.log(`Daily: ${s.maxSatsPerDay ?? "none"} (spent ${s.spentToday})`);
      console.log(`Lifetime: ${s.maxSatsLifetime ?? "none"} (spent ${s.spentLifetime})`);
      console.log(
        `Allowlist: ${s.allowlist === null ? "unrestricted" : s.allowlist.length === 0 ? "(empty)" : s.allowlist.join(", ")}`,
      );
      console.log(`Killfile: ${s.killfile ? "on" : "off"}`);
      console.log(`Key present: ${s.keyPresent ? "yes" : "NO"}`);
      break;
    }
    case "allow": {
      if (!a) die("Usage: allow <p2pkh-address>");
      const list = allowDestination(root, a);
      console.log(`Allowlist: ${list.join(", ")}`);
      break;
    }
    case "kill":
      killVault(root);
      console.log("STOP_SPENDING set. Sends will fail until a human deletes that file.");
      break;
    case "send": {
      if (!a || !b) die("Usage: send <to-address> <sats> [note]");
      const amount = Number(b);
      const result = await sendPayment({ root, to: a, amount, note: rest.join(" ") });
      if (!result.ok) die(result.message);
      console.log(`txid: ${result.txid}`);
      console.log(`sent: ${result.amount} sats to ${result.to} (fee ${result.fee})`);
      break;
    }
    case "sweep": {
      if (!a) die("Usage: sweep <p2pkh-address>");
      const result = await sweepPayment({ root, to: a, note: "sweep" });
      if (!result.ok) die(result.message);
      console.log(`txid: ${result.txid}`);
      console.log(`swept: ${result.amount} sats to ${result.to} (fee ${result.fee})`);
      break;
    }
    case "split": {
      const pieceSats = a ? Number(a) : undefined;
      const result = await splitPayment({ root, pieceSats });
      if (!result.ok) die(result.message);
      console.log(`txid: ${result.txid}`);
      console.log(`split: ${result.pieces?.length ?? 0} outputs (fee ${result.fee})`);
      break;
    }
    case "x402-inspect": {
      if (!a) die("Usage: x402-inspect <X402-Challenge-header>");
      const vault = loadVault(root);
      const challenge = decodeChallengeHeader(a);
      const result = decideX402(vault.policy, loadUsage(root), challenge);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      break;
    }
    case "mcp": {
      const { runMcp } = await import("./mcp");
      await runMcp(root);
      break;
    }
    case "mcp-http": {
      const { runHttp } = await import("./http");
      await runHttp(root);
      break;
    }
    default:
      die(`Unknown command: ${cmd}\n${HELP}`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
