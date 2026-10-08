#!/usr/bin/env bun
import { defaultFetchUtxos } from "./send";
import { sendPayment, sweepPayment, splitPayment } from "./send";
import { decideX402, decodeChallengeHeader, buildProof, encodeProofHeader, inspectProof } from "./x402";
import { settleX402 } from "./delegator";
import { inspectDescriptor, lockingScriptHex, revocationScriptHex, fundAllowance, sweepAllowance } from "./allowance";
import { fundRequest } from "./fund-request";
import { verifyPolicyEnvelope, loadPolicyEnvelope } from "./brc181";
import { allowDestination, defaultVaultDir, initVault, killVault, loadUsage, loadVault, statusVault, vaultPaths } from "./vault";
import { readFileSync, existsSync, appendFileSync } from "node:fs";

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
  bun src/cli.ts fund-request <sats>
  bun src/cli.ts kill
  bun src/cli.ts sweep <p2pkh-address>
  bun src/cli.ts split [piece-sats]
  bun src/cli.ts x402-inspect <X402-Challenge-header>
  bun src/cli.ts x402-proof <X402-Challenge-header> <rawtx-hex> [method] [path]
  bun src/cli.ts x402-delegate <X402-Challenge-header> [method] [path] [--broadcast]
  bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
  bun src/cli.ts allowance-inspect <descriptor-json-or-file>
  bun src/cli.ts allowance-fund <agent-pubkey-hex> <sats> [pieces]
  bun src/cli.ts allowance-sweep [p2pkh-address]
  bun src/cli.ts policy-inspect <envelope-json-or-file>
  bun src/cli.ts mcp
  bun src/cli.ts mcp-http

The LLM never sees the key. Policy lives in the signer.
allow, sweep, split, fund-request, allowance-*, and policy-inspect are human-only (not MCP tools).
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
    case "fund-request": {
      if (!a) die("Usage: fund-request <sats>");
      const vault = loadVault(root);
      const result = fundRequest({ address: vault.address, sats: Number(a) });
      if (!result.ok) die(result.message);
      console.log(JSON.stringify(result, null, 2));
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
    case "x402-proof": {
      if (!a || !b) die("Usage: x402-proof <X402-Challenge-header> <rawtx-hex> [method] [path]");
      const challenge = decodeChallengeHeader(a);
      const proof = buildProof({
        challenge,
        rawtxHex: b,
        method: rest[0] || "GET",
        path: rest[1] || challenge.path || "/",
        query: challenge.query,
      });
      const check = inspectProof(proof, { challenge, requestPath: proof.request.path });
      if (!check.ok) die(check.message);
      console.log(JSON.stringify({ header: encodeProofHeader(proof), proof }, null, 2));
      break;
    }
    case "x402-delegate": {
      if (!a) die("Usage: x402-delegate <X402-Challenge-header> [method] [path] [--broadcast]");
      const vault = loadVault(root);
      const challenge = decodeChallengeHeader(a);
      const extra = [b, ...rest].filter((x): x is string => Boolean(x));
      const wantBroadcast = extra.includes("--broadcast");
      const positional = extra.filter((x) => x !== "--broadcast");
      const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
      if (!loaded.ok) die(loaded.message);
      const result = await settleX402({
        policy: vault.policy,
        usage: loadUsage(root),
        challenge,
        method: positional[0] || challenge.method,
        path: positional[1] || challenge.path,
        broadcast: wantBroadcast ? true : undefined,
        envelope: loaded.envelope,
        fund: { key: vault.key, address: vault.address },
        onSpend: (entry) => appendFileSync(vaultPaths(root).log, `${JSON.stringify(entry)}\n`),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      break;
    }
    case "allowance-script": {
      if (!a || !b) die("Usage: allowance-script <agent-pubkey-hex> <owner-pubkey-hex>");
      try {
        const lock = lockingScriptHex(a, b);
        const revocation = revocationScriptHex(b);
        console.log(JSON.stringify({ lock, revocation, agentUnlock: "<sig> OP_1", ownerUnlock: "<sig> OP_0" }, null, 2));
      } catch {
        die("REJECTED: Pubkeys must be compressed secp256k1 hex (02/03 + 32 bytes).");
      }
      break;
    }
    case "allowance-inspect": {
      if (!a) die("Usage: allowance-inspect <descriptor-json-or-file>");
      const text = existsSync(a) ? readFileSync(a, "utf8") : [a, b, ...rest].filter(Boolean).join(" ");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        die("REJECTED: Descriptor is not JSON.");
      }
      const result = inspectDescriptor(parsed);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      break;
    }
    case "allowance-fund": {
      if (!a || !b) die("Usage: allowance-fund <agent-pubkey-hex> <sats> [pieces]");
      const amount = Number(b);
      const pieces = rest[0] ? Number(rest[0]) : undefined;
      const result = await fundAllowance({ root, agentPubHex: a, amount, pieces });
      if (!result.ok) die(result.message);
      const { masterKeyring: _omit, ...publicDescriptor } = result.descriptor as Record<string, unknown>;
      console.log(JSON.stringify({ txid: result.txid, amount: result.amount, fee: result.fee, descriptor: publicDescriptor }, null, 2));
      break;
    }
    case "allowance-sweep": {
      const result = await sweepAllowance({ root, to: a });
      if (!result.ok) die(result.message);
      console.log(`txid: ${result.txid}`);
      console.log(`swept: ${result.amount} sats (fee ${result.fee})`);
      break;
    }
    case "policy-inspect": {
      if (!a) die("Usage: policy-inspect <envelope-json-or-file>");
      const text = existsSync(a) ? readFileSync(a, "utf8") : [a, b, ...rest].filter(Boolean).join(" ");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        die("REJECTED: Policy envelope is not JSON.");
      }
      const env = parsed as { payload?: Record<string, unknown>; sig?: { alg: string; issuer: string; signature: string } };
      if (!env.payload || !env.sig) die("REJECTED: Envelope needs payload and sig.");
      const result = verifyPolicyEnvelope({ payload: env.payload, sig: env.sig });
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
