#!/usr/bin/env bun
import { defaultFetchUtxos } from "./send";
import type { BridgeProvider } from "./bridge";
import { sendPayment, sweepPayment, splitPayment, sendRaw } from "./send";
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
  bun src/cli.ts evm-address
  bun src/cli.ts evm-balance
  bun src/cli.ts sol-address
  bun src/cli.ts sol-balance [--devnet]
  bun src/cli.ts x402-pay <url>
  bun src/cli.ts delegator [port]
  bun src/cli.ts bridge-quote <sats>
  bun src/cli.ts bridge-rebalance [sats]
  bun src/cli.ts bridge-status <orderId>
  bun src/cli.ts merchant [port]
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
      if (!a) die("Usage: x402-delegate <X402-Challenge-header> [method] [path] [--broadcast] [--vault-fund]");
      const vault = loadVault(root);
      const challenge = decodeChallengeHeader(a);
      const extra = [b, ...rest].filter((x): x is string => Boolean(x));
      const wantBroadcast = extra.includes("--broadcast");
      const vaultFund = extra.includes("--vault-fund");
      const positional = extra.filter((x) => x !== "--broadcast" && x !== "--vault-fund");
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
        fund: vaultFund ? { key: vault.key, address: vault.address } : undefined,
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
          url: a,
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
        console.log(JSON.stringify(r, null, 2));
        break;
      } catch (e) {
        // Policy, funding, and settlement failures never switch currencies.
        if (!(e instanceof BsvX402Error) || e.code !== "UNSUPPORTED") throw e;
      }
      const { deriveEvmAddress } = await import("./evm");
      const { settleUsdcX402, UsdcX402Error } = await import("./evm-x402");
      try {
        const r = await settleUsdcX402({
          url: a,
          key: vault.key,
          from: deriveEvmAddress(vault.key),
          pocket: vault.policy.evm?.usdc,
          killfileOn: vault.policy.killfileOn,
          usage: loadUsage(root, new Date(), "usdc-base"),
          onSpend: (row) => appendFileSync(vaultPaths(root).log, JSON.stringify(row) + "\n"),
        });
        console.log(JSON.stringify(r, null, 2));
      } catch (e) {
        // No base/USDC requirement offered? Try the Solana pocket before failing.
        if (!(e instanceof UsdcX402Error) || e.code !== "UNSUPPORTED") throw e;
        const { deriveSolanaAddress } = await import("./solana");
        const { settleSolanaX402 } = await import("./solana-x402");
        const r = await settleSolanaX402({
          url: a,
          key: vault.key,
          from: deriveSolanaAddress(vault.key),
          pocket: vault.policy.solana?.usdc,
          killfileOn: vault.policy.killfileOn,
          usage: loadUsage(root, new Date(), "usdc-solana"),
          onSpend: (row) => appendFileSync(vaultPaths(root).log, JSON.stringify(row) + "\n"),
        });
        console.log(JSON.stringify(r, null, 2));
      }
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
      const vault = loadVault(root);
      const { deriveEvmAddress, usdcBalanceOf } = await import("./evm");
      const { loadBridgeConfig, planRebalance, executeRebalance } = await import("./bridge");
      const cfg = loadBridgeConfig(vaultPaths(root).bridge);
      const providers = await bridgeProviders(root);
      const ourPocket = deriveEvmAddress(vault.key);
      let amountSats = a ? Number(a) : null;
      if (amountSats === null) {
        const usdc = await usdcBalanceOf(ourPocket);
        const utxos = await defaultFetchUtxos(vault.address);
        const bsvSats = utxos.reduce((s, u) => s + u.value, 0);
        const plan = planRebalance({ usdcBalance: Number(usdc), bsvBalanceSats: bsvSats, thresholds: cfg.thresholds });
        if (!plan) {
          console.log(JSON.stringify({ ok: true, action: "none", reason: "USDC float above low-water or BSV float too small", usdc: usdc.toString(), bsvSats }, null, 2));
          break;
        }
        amountSats = plan.fromAmountSats;
      }
      const logPath = vaultPaths(root).log;
      const r = await executeRebalance({
        bridge: vault.policy.bridge,
        killfileOn: vault.policy.killfileOn,
        usage: loadUsage(root, new Date(), "bridge-bsv"),
        providers,
        fromAmountSats: amountSats,
        ourPocket,
        send: async (to, sats) => {
          const res = await sendRaw({ root, to, amount: sats });
          if (!res.ok) throw new Error(res.message);
          return { txid: res.txid };
        },
        logRow: (row) => appendFileSync(logPath, JSON.stringify(row) + "\n"),
      });
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      break;
    }
    case "bridge-status": {
      if (!a) die("Usage: bridge-status <orderId>");
      const { recordFinishedArrival } = await import("./bridge");
      const providers = await bridgeProviders(root);
      const logPath = vaultPaths(root).log;
      const rows: Record<string, unknown>[] = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        : [];
      const logged = rows.find((r) => r.orderId === a && typeof r.provider === "string");
      const ordered = logged
        ? [...providers.filter((p) => p.name === logged.provider), ...providers.filter((p) => p.name !== logged.provider)]
        : providers;
      let ord = null;
      for (const p of ordered) {
        try {
          ord = await p.status(a);
          break;
        } catch {
          continue;
        }
      }
      if (!ord) die(`REJECTED: no provider recognized order ${a}.`);
      const recorded = recordFinishedArrival(ord, rows);
      if (recorded) appendFileSync(logPath, JSON.stringify(rows[rows.length - 1]) + "\n");
      console.log(JSON.stringify({ ok: true, order: ord, arrivalLogged: recorded }, null, 2));
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
              return async (payment: unknown, requirement: never) =>
                selfSettle({ chain, account, payment: payment as never, requirement, ownPayTo: payTo });
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
