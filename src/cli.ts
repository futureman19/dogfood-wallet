#!/usr/bin/env bun
import { defaultFetchUtxos } from "./send";
import type { BridgeProvider } from "./bridge";
import { sendPayment, sweepPayment, splitPayment } from "./send";
import { decideX402, decodeChallengeHeader, buildProof, encodeProofHeader, inspectProof } from "./x402";
import { delegateX402 } from "./x402-delegate";
import { inspectDescriptor, lockingScriptHex, revocationScriptHex, fundAllowance, sweepAllowance, listAllowances } from "./allowance";
import { fundRequest } from "./fund-request";
import { verifyPolicyEnvelope } from "./brc181";
import { allowDestination, defaultVaultDir, initVault, killVault, loadUsage, loadVault, statusVault, vaultPaths } from "./vault";
import { readFileSync, existsSync } from "node:fs";

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

const HELP = `Dogfood Wallet — local BSV agent vault (mainnet)

  bun src/cli.ts init
  bun src/cli.ts address
  bun src/cli.ts balance
  bun src/cli.ts status
  bun src/cli.ts doctor
  bun src/cli.ts payment-inspect
  bun src/cli.ts allow <p2pkh-address>
  bun src/cli.ts send <to-address> <sats> [--max-fee <sats>] [--] [note]
  bun src/cli.ts agent-deposit <agent-id> <sats> [--no-broadcast]
  bun src/cli.ts agent-post <agent.action> '<body-json: {route,body}>' [--no-post]
  bun src/cli.ts agent-call <agent.action> <POST|PUT|DELETE> <path> '<body-json>'
  bun src/cli.ts agent-buy <listing-outpoint> <max-price-sats> [--no-broadcast]
  bun src/cli.ts agent-attest '<observation-json>' [--no-broadcast]
  bun src/cli.ts agent-attest-verify <txid>
  bun src/cli.ts agent-mint <name> <lat> <lng> [--no-broadcast]
  bun src/cli.ts agent-register <mint-txid> <name> <lat> <lng> [--no-post]
  bun src/cli.ts agent-list <ordinal-outpoint> <price-sats> [--no-broadcast]
  bun src/cli.ts agent-cancel-listing <listing-outpoint> [--no-broadcast]
  bun src/cli.ts fund-request <sats>
  bun src/cli.ts kill
  bun src/cli.ts sweep <p2pkh-address>
  bun src/cli.ts split [piece-sats]
  bun src/cli.ts x402-inspect <X402-Challenge-header>
  bun src/cli.ts x402-proof <X402-Challenge-header> <rawtx-hex> [method] [path]
  bun src/cli.ts x402-delegate <X402-Challenge-header> [method] [path] [--broadcast]
  bun src/cli.ts evm-address
  bun src/cli.ts btc-address
  bun src/cli.ts btc-balance
  bun src/cli.ts btc-send <destination> <sats>
  bun src/cli.ts evm-balance
  bun src/cli.ts sol-address
  bun src/cli.ts sol-balance [--devnet]
  bun src/cli.ts x402-pay <url>
  bun src/cli.ts delegator [port]
  bun src/cli.ts bridge-quote <sats>
  bun src/cli.ts bridge-rebalance [sats]  (fund once; no automatic retry)
  bun src/cli.ts bridge-reconcile <intentId>  (owner-only verified settlement)
  bun src/cli.ts bridge-status [orderId]  (local read-only evidence)
  bun src/cli.ts merchant [port]
  bun src/cli.ts allowance-script <agent-pubkey-hex> <owner-pubkey-hex>
  bun src/cli.ts allowance-inspect <descriptor-json-or-file>
  bun src/cli.ts allowance-fund <agent-pubkey-hex> <sats> [pieces]
  bun src/cli.ts allowance-list
  bun src/cli.ts allowance-sweep [p2pkh-address]
  bun src/cli.ts allowance-sweep --record <record-id> [p2pkh-address]
  bun src/cli.ts policy-inspect [envelope-json-or-file]  (no argument: local policy)
  bun src/cli.ts policy-issue --origin <token> --per-tx <n> --total <n> --max-fee <n> --purpose <text> [--allow <dest>]... [--dest-cap <dest>=<n>]... [--expires <epoch>] [--write] [--force]
  bun src/cli.ts mcp
  bun src/cli.ts mcp-http

Send --max-fee: optional nonnegative safe integer, decimal digits only; actual miner fee ceiling.
Use -- before literal note tokens beginning with -. No preview or automatic retry.
The LLM never sees the key. Policy lives in the signer.
btc-send is human-only (never MCP), broadcasts by default; no automatic retry.
agent-deposit is human-only: broadcasts by default; --no-broadcast SIGNS rawTx and RETAINS a payment hold.
agent-mint and agent-register are human-only: broadcast / metadata POST by default.
--no-broadcast is unsigned; --no-post prints a usable signed authorization, not a receipt.
agent-call is human-only: prints an offline signed Gryd envelope; never sends it.
agent-buy is human-only: purchases on chain by default; --no-broadcast is an unsigned preview.
agent-list and agent-cancel-listing are human-only: broadcast by default; unsigned --no-broadcast preview.
Phase 3 backend compatibility is pending; do not use live until the Gryd verifier is updated.
allow, sweep, split, fund-request, allowance-*, policy-inspect, and policy-issue are human-only (not MCP tools).
Vault dir: $DOGFOOD_WALLET_DIR or ~/.dogfood-wallet
`;

// Exolix is always available (no API key); ChangeNOW joins when bridge.json
// carries a key. Add future providers here.
async function bridgeProviders(root: string) {
  const { loadBridgeConfig } = await import("./bridge");
  const { exolixProvider } = await import("./bridge-exolix");
  const { changenowProvider } = await import("./bridge-changenow");
  const cfg = loadBridgeConfig(vaultPaths(root).bridge);
  const providers: BridgeProvider[] = [exolixProvider({})];
  if (cfg.changenowApiKey) providers.push(changenowProvider({ apiKey: cfg.changenowApiKey }));
  return providers;
}

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
    case "btc-address":
    case "btc-balance": {
      if(a!==undefined)die(`Usage: ${cmd}`);
      const {btcAddress,btcBalance}=await import('./btc');
      const address=btcAddress(loadVault(root).key);
      console.log(cmd==='btc-address'?address:JSON.stringify({address,...await btcBalance(address)},null,2));
      break;
    }
    case "btc-send": {
      if(!a||!b||rest.length||! /^[0-9]+$/.test(b)||!Number.isSafeInteger(Number(b))||Number(b)<=0)die('Usage: btc-send <destination> <sats>; positive decimal integer sats only');
      const {sendBtc}=await import('./btc');
      console.log(JSON.stringify(await sendBtc({root,to:a,sats:Number(b)}),null,2));
      break;
    }
    case "init": {
      const { address } = initVault(root);
      console.log("Initialized.");
      console.log(`Address: ${address}`);
      console.log(`Vault: ${root}`);
      console.log("Fund this address. Do not print or copy the key.");
      console.log("Allowlist is empty. Human next: bun src/cli.ts allow <p2pkh-address>");
      break;
    }
    case "agent-attest": {
      const args = process.argv.slice(3);
      if ((args.length !== 1 && args.length !== 2) || (args.length === 2 && args[1] !== "--no-broadcast")) die("Usage: agent-attest '<observation-json>' [--no-broadcast]");
      if (Buffer.byteLength(args[0]!, "utf8") > 32768) die("Invalid observation JSON size");
      const { attestAgent, validateObservation } = await import("./gryd-attest");
      const observation = validateObservation(JSON.parse(args[0]!));
      console.log(JSON.stringify(await attestAgent({ root, observation, noBroadcast: args.length === 2 }), null, 2));
      break;
    }
    case "agent-attest-verify": {
      const args = process.argv.slice(3);
      if (args.length !== 1 || !/^[a-f0-9]{64}$/.test(args[0]!)) die("Usage: agent-attest-verify <lowercase-64-hex-txid>");
      const { verifyAttestationTx } = await import("./gryd-attest");
      console.log(JSON.stringify(await verifyAttestationTx(args[0]!), null, 2));
      break;
    }
    case "agent-mint":
    case "agent-register": {
      const args = process.argv.slice(3), registering = cmd === "agent-register";
      const count = registering ? 4 : 3, flag = registering ? "--no-post" : "--no-broadcast";
      if (args.length !== count && args.length !== count + 1 || args.length === count + 1 && args[count] !== flag) die(`Usage: ${cmd} ${registering ? "<mint-txid> " : ""}<name> <lat> <lng> [${flag}]`);
      const [name, latText, lngText] = args.slice(registering ? 1 : 0, count);
      const decimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
      if (!latText || !lngText || !decimal.test(latText) || !decimal.test(lngText)) die("Coordinates must be signed decimal numbers, not hex/exponents/whitespace");
      const { mintAgent, registerAgent } = await import("./gryd-mint");
      const common = {root, name: name!, lat: Number(latText), lng: Number(lngText)};
      const result = registering
        ? await registerAgent({...common, mintTxid: args[0]!, noPost: args[count] === flag})
        : await mintAgent({...common, noBroadcast: args[count] === flag});
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "agent-list": {
      if (!a || !b || !/^[0-9]+$/.test(b) || !Number.isSafeInteger(Number(b)) || Number(b) <= 0
        || rest.length > 1 || (rest.length === 1 && rest[0] !== "--no-broadcast")) {
        die("Usage: agent-list <ordinal-outpoint> <price-sats> [--no-broadcast]; positive decimal integer sats only");
      }
      const { listAgent } = await import("./gryd-listings");
      console.log(JSON.stringify(await listAgent({ root, ordinalOutpoint: a, priceSats: Number(b), noBroadcast: rest[0] === "--no-broadcast" }), null, 2));
      break;
    }
    case "agent-cancel-listing": {
      if (!a || rest.length || (b !== undefined && b !== "--no-broadcast")) die("Usage: agent-cancel-listing <listing-outpoint> [--no-broadcast]");
      const { cancelAgentListing } = await import("./gryd-listings");
      console.log(JSON.stringify(await cancelAgentListing({ root, listingOutpoint: a, noBroadcast: b === "--no-broadcast" }), null, 2));
      break;
    }
    case "agent-buy": {
      if (!a || !b || !/^[0-9]+$/.test(b) || !Number.isSafeInteger(Number(b)) || Number(b) <= 0
        || rest.length > 1 || (rest.length === 1 && rest[0] !== "--no-broadcast")) {
        die("Usage: agent-buy <listing-outpoint> <max-price-sats> [--no-broadcast]; positive decimal integer sats only");
      }
      const { buyAgent } = await import("./gryd-buy");
      const result = await buyAgent({ root, listingOutpoint: a, maxPriceSats: Number(b), noBroadcast: rest[0] === "--no-broadcast" });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "agent-deposit": {
      if (!a || !b || !/^[0-9]+$/.test(b) || !Number.isSafeInteger(Number(b)) || Number(b) <= 0
        || rest.length > 1 || (rest.length === 1 && rest[0] !== "--no-broadcast")) {
        die("Usage: agent-deposit <agent-id> <sats> [--no-broadcast]; positive decimal integer sats only");
      }
      const { depositAgent } = await import("./gryd-deposit");
      console.log(JSON.stringify(await depositAgent({root, agentId:a, sats:Number(b), noBroadcast:rest[0] === "--no-broadcast"}), null, 2));
      break;
    }
    case "agent-post": {
      if (!a || !b || rest.length > 1 || rest.length === 1 && rest[0] !== "--no-post") die("Usage: agent-post <agent.action> '<body-json: {route,body}>' [--no-post]");
      const {postAgent} = await import("./gryd-post");
      let input: unknown;
      try { input = JSON.parse(b); } catch { die("Body must be valid JSON"); }
      console.log(JSON.stringify(await postAgent({root, action:a, input, noPost:rest[0] === "--no-post"}), null, 2));
      break;
    }
    case "agent-call": {
      if (!a || !b || rest.length !== 2) die("Usage: agent-call <agent.action> <POST|PUT|DELETE> <path> '<body-json>' (offline signing only)");
      const { signVaultAgentRequest } = await import("./gryd-agent");
      let body: Record<string, unknown>;
      try { body = JSON.parse(rest[1]!); } catch { die("Body must be valid JSON"); }
      const signed = signVaultAgentRequest(root, a as import("./gryd-agent").SignedWriteAction, body, { method: b as "POST" | "PUT" | "DELETE", path: rest[0]! });
      console.log(JSON.stringify(signed, null, 2));
      break;
    }
    case "address":
      console.log(loadVault(root).address);
      break;
    case "balance":
      await cmdBalance(root);
      break;
    case "doctor": {
      const { doctor } = await import("./doctor");
      console.log(JSON.stringify(doctor(root), null, 2));
      break;
    }
    case "payment-inspect": {
      const { inspectPaymentHold } = await import("./payment-guard");
      console.log(JSON.stringify(inspectPaymentHold(root), null, 2));
      break;
    }
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
      if (!a || !b) die("Usage: send <to-address> <sats> [--max-fee <sats>] [--] [note]");
      const amount = Number(b);
      let maxFeeSats: number | undefined;
      const note: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i]!;
        if (token === "--") {
          note.push(...rest.slice(i + 1));
          break;
        }
        if (token === "--max-fee") {
          if (maxFeeSats !== undefined) die("REJECTED: Duplicate --max-fee.");
          const value = rest[++i];
          if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
            die("REJECTED: --max-fee requires a nonnegative safe integer in decimal digits (separate token).");
          }
          maxFeeSats = Number(value);
        } else {
          if (token.startsWith("-")) die("REJECTED: Unknown send option. Use -- before literal note text beginning with '-'.");
          note.push(token);
        }
      }
      const result = await sendPayment({ root, to: a, amount, maxFeeSats, note: note.join(" ") });
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
      if (!a) die("Usage: x402-delegate <X402-Challenge-header> [method] [path] [--broadcast] [--vault-fund]");
      const challenge = decodeChallengeHeader(a);
      const extra = [b, ...rest].filter((x): x is string => Boolean(x));
      const wantBroadcast = extra.includes("--broadcast");
      const vaultFund = extra.includes("--vault-fund");
      const positional = extra.filter((x) => x !== "--broadcast" && x !== "--vault-fund");
      const result = await delegateX402(root, {
        challenge,
        method: positional[0] || challenge.method,
        path: positional[1] || challenge.path,
        broadcast: wantBroadcast ? true : undefined,
        vaultFund,
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
    case "allowance-list": {
      console.log(JSON.stringify(await listAllowances(root), null, 2));
      break;
    }
    case "allowance-sweep": {
      if (a === "--record" && !b) die("Usage: allowance-sweep --record <record-id> [p2pkh-address]");
      const result = await sweepAllowance({ root, to: a === "--record" ? rest[0] : a, recordId: a === "--record" ? b : undefined });
      if (!result.ok) die(result.message);
      console.log(`txid: ${result.txid}`);
      console.log(`swept: ${result.amount} sats (fee ${result.fee})`);
      break;
    }
    case "policy-issue": {
      // Human-only: mint a signed BRC-181 envelope with the vault key as issuer.
      // Prints the envelope JSON; --write installs it as the vault's brc181.json
      // (gates every payment rail), --force replaces an installed envelope.
      const { issuePolicyEnvelope, parsePolicyIssueFlags, writePolicyEnvelope } = await import("./policy-issue");
      const flags = parsePolicyIssueFlags([a, b, ...rest].filter((x): x is string => typeof x === "string"));
      if (!flags.ok) die(flags.message);
      try {
        const envelope = issuePolicyEnvelope(loadVault(root).key, flags.value);
        if (flags.value.write) {
          writePolicyEnvelope(root, envelope, { force: flags.value.force });
          console.log("brc181.json installed. It now gates every rail alongside policy.json — review any time with policy-inspect.");
        } else {
          console.log(JSON.stringify(envelope, null, 2));
        }
      } catch (e) {
        die(e instanceof Error ? e.message : "REJECTED: could not issue the policy envelope.");
      }
      break;
    }
    case "policy-inspect": {
      if (!a) {
        const { parseStoredPolicy } = await import("./vault");
        const paths = vaultPaths(root);
        const policy = parseStoredPolicy(readFileSync(paths.policy, "utf8"), existsSync(paths.kill));
        console.log(JSON.stringify({ ok: true, ...policy }, null, 2));
        break;
      }
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
    case "delegator": {
      const { runFeeDelegatorServer, defaultDelegatorDir } = await import("./fee-delegator");
      const port = Number(b ?? process.env.DOGFOOD_DELEGATOR_PORT ?? 8403);
      const srv = await runFeeDelegatorServer({ root: defaultDelegatorDir(), port });
      console.log(
        `Fee delegator listening on http://127.0.0.1:${srv.port} (pool ${srv.address}). POST /delegate/x402 {partial_tx}. Ctrl-C to stop.`,
      );
      await new Promise(() => {});
      break;
    }
    case "evm-address": {
      const { deriveEvmAddress } = await import("./evm");
      console.log(deriveEvmAddress(loadVault(root).key));
      break;
    }
    case "evm-balance": {
      const { deriveEvmAddress, usdcBalanceOf } = await import("./evm");
      const address = deriveEvmAddress(loadVault(root).key);
      const bal = await usdcBalanceOf(address);
      console.log(
        JSON.stringify({ network: "base", address, usdcBaseUnits: bal.toString(), usdc: (Number(bal) / 1e6).toFixed(6) }, null, 2),
      );
      break;
    }
    case "sol-address": {
      const { deriveSolanaAddress } = await import("./solana");
      console.log(deriveSolanaAddress(loadVault(root).key));
      break;
    }
    case "sol-balance": {
      const { deriveSolanaAddress, solanaUsdcBalance, USDC_SOLANA, USDC_SOLANA_DEVNET, SOLANA_RPC, SOLANA_DEVNET_RPC } =
        await import("./solana");
      const devnet = process.argv.includes("--devnet");
      const address = deriveSolanaAddress(loadVault(root).key);
      const bal = await solanaUsdcBalance({
        address,
        mint: devnet ? USDC_SOLANA_DEVNET : USDC_SOLANA,
        rpcUrl: devnet ? SOLANA_DEVNET_RPC : SOLANA_RPC,
      });
      console.log(
        JSON.stringify(
          { network: devnet ? "solana-devnet" : "solana", address, usdcBaseUnits: bal.toString(), usdc: (Number(bal) / 1e6).toFixed(6) },
          null,
          2,
        ),
      );
      break;
    }
    case "x402-pay": {
      if (!a) die("Usage: x402-pay <url>");
      const { payX402 } = await import("./x402-pay");
      console.log(JSON.stringify(await payX402(root, a), null, 2));
      break;
    }
    case "bridge-quote": {
      if (!a) die("Usage: bridge-quote <sats>");
      const providers = await bridgeProviders(root);
      const { bestQuote } = await import("./bridge");
      const q = await bestQuote(providers, { fromAmountSats: Number(a) });
      console.log(JSON.stringify(q, null, 2));
      break;
    }
    case "bridge-rebalance": {
      const { fundBridge } = await import("./bridge-funded");
      console.log(JSON.stringify(await fundBridge({root, providers: await bridgeProviders(root), fromAmountSats: a === undefined ? undefined : Number(a)}), null, 2));
      break;
    }
    case "bridge-reconcile": {
      if (!a) die("Usage: bridge-reconcile <intentId>");
      const { reconcileBridge } = await import("./bridge-funded");
      console.log(JSON.stringify(await reconcileBridge({root, intentId:a, providers:await bridgeProviders(root)}), null, 2));
      break;
    }
    case "bridge-status": {
      const { inspectFundedBridge } = await import("./bridge-funded");
      const records = inspectFundedBridge(root);
      if (records.length) {
        const selected = a ? records.filter(r => ("orderId" in r && r.orderId === a) || ("intentId" in r && r.intentId === a)) : records;
        if (!selected.length) die("REJECTED: no matching local bridge evidence.");
        console.log(JSON.stringify(selected, null, 2));
        break;
      }
      const { inspectBridgeOrder } = await import("./bridge");
      const status = inspectBridgeOrder(root);
      if (a && (!("orderId" in status) || status.orderId !== a)) die("REJECTED: order does not match local bridge evidence. No provider lookup or accounting performed.");
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "merchant": {
      const { deriveEvmAddress } = await import("./evm");
      const { createMerchantApp } = await import("./merchant");
      // Explicit public env addresses allow local verification without loading any key.
      const payTo = process.env.DOGFOOD_MERCHANT_PAYTO ?? deriveEvmAddress(loadVault(root).key);
      const port = Number(a ?? process.env.DOGOOD_MERCHANT_PORT ?? 8404);
      const network = process.env.DOGFOOD_MERCHANT_NETWORK ?? "base-sepolia";
      const facilitatorUrl = process.env.DOGFOOD_FACILITATOR_URL ?? "https://x402.org/facilitator";
      const priceBaseUnits = Number(process.env.DOGFOOD_MERCHANT_PRICE ?? 1_000);
      const statePath = process.env.DOGFOOD_MERCHANT_STATE;
      const { createFileReplayStore } = await import("./replay-store");
      // DOGFOOD_SELF_FACILITATE=1: settle mainnet USDC ourselves (local only —
      // loads the vault key, pays gas from the pocket's ETH).
      const selfFacilitate = process.env.DOGFOOD_SELF_FACILITATE === "1";
      const app = createMerchantApp({
        payTo,
        bsvPayTo: process.env.DOGFOOD_MERCHANT_BSV_PAYTO,
        bsvSatoshis: Number(process.env.DOGFOOD_MERCHANT_BSV_SATS ?? 500),
        replayStore: statePath ? createFileReplayStore(statePath) : undefined,
        settleFn: selfFacilitate
          ? await (async () => {
              const { makeBaseFacilitatorChain, selfSettle } = await import("./facilitator");
              const { chain, account } = makeBaseFacilitatorChain(loadVault(root).key);
              return async (payment: unknown, requirement: import("./merchant").PaymentRequirement) =>
                selfSettle({ chain, account, payment: payment as Parameters<typeof selfSettle>[0]["payment"], requirement, ownPayTo: payTo });
            })()
          : undefined,
        ...(selfFacilitate
          ? await (async () => {
              const vault = loadVault(root);
              const { deriveSolanaAddress } = await import("./solana");
              return {
                solanaPayTo: deriveSolanaAddress(vault.key),
                solanaFeePayerKey: vault.key,
                solanaNetwork: process.env.DOGFOOD_MERCHANT_SOL_NETWORK ?? "solana-devnet",
              };
            })()
          : {}),
        priceBaseUnits,
        resourcePath: "/v1/fortune",
        facilitatorUrl,
        network,
      });
      Bun.serve({ port, hostname: "0.0.0.0", fetch: app });
      console.log(`Merchant listening on :${port} (${network}, $${priceBaseUnits / 1e6}/call, payTo vault pocket). Ctrl-C to stop.`);
      await new Promise(() => {});
      break;
    }
    default:
      die(`Unknown command: ${cmd}\n${HELP}`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
