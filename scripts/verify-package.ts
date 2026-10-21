// Explicit opt-in integration: registry downloads, never publication or global install.
import assert from "node:assert/strict";
import { isExcludedPackagePath } from "./package-paths";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "dogfood-package-"));
const consumer = join(scratch, "consumer");
const unrelated = join(scratch, "unrelated");
for (const dir of [consumer, unrelated]) mkdirSync(dir);
// Do not inherit wallet/provider credentials or Bun preload/NODE_PATH settings.
const env: Record<string, string> = {};
for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
  if (process.env[key]) env[key] = process.env[key]!;
}
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, BUN_INSTALL_CACHE_DIR: join(scratch, "cache"), npm_config_cache: join(scratch, "npm-cache"), DOGFOOD_WALLET_DIR: join(scratch, "vault") });
function run(command: string[], cwd = unrelated, expected = 0) {
  const p = Bun.spawnSync(command, { cwd, env, timeout: 120000 });
  assert.equal(p.exitCode, expected, `Subprocess failed: ${command[0]} ${command[1]}\n${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
try {
  const npm = Bun.which("npm");
  assert(npm, "npm is required for the pack JSON inventory");
  const inventory = JSON.parse(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repo));
  const pack: any = Array.isArray(inventory) ? inventory[0] : Object.values(inventory)[0];
  const paths = pack.files.map((f: any) => f.path).sort();
  assert(Array.isArray(manifest.files), "package must have an explicit files allowlist");
  assert.deepEqual(paths, [...new Set([...manifest.files, "package.json"])].sort(), "Unexpected or missing packed files");
  assert(!paths.some(isExcludedPackagePath), "Excluded/private inventory path");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "dogfood-package-consumer", private: true, dependencies: { "@dogfood/wallet": `file:${join(scratch, pack.filename).replaceAll("\\", "/")}` } }));
  run([process.execPath, "install", "--ignore-scripts"], consumer);
  const installed = join(consumer, "node_modules", "@dogfood", "wallet");
  assert(realpathSync(installed).startsWith(realpathSync(scratch)), "Package escaped scratch");
  const cli = join(installed, manifest.bin["dogfood-wallet"]);
  const deny = join(scratch, "deny-network.ts");
  writeFileSync(deny, `globalThis.fetch = Object.assign(() => { throw new Error("PACKAGE_SMOKE_NETWORK_FORBIDDEN"); }, { preconnect() { throw new Error("PACKAGE_SMOKE_NETWORK_FORBIDDEN"); } });`);
  const args = ["--no-install", "--preload", deny];
  const cliRun = (...commands: string[]) => {
    const output = run([process.execPath, ...args, cli, ...commands]);
    assert(!/"(?:wif|privateKey|masterKeyring|wrapKey|seed)"\s*:/i.test(output), "Private CLI field exposed");
    return output;
  };
  assert(cliRun("--help").includes("Dogfood Wallet"));
  assert.equal(JSON.parse(cliRun("doctor")).vault, "missing");
  assert(cliRun("init").includes("Allowlist is empty"));
  const address = cliRun("address");
  assert.match(address, /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
  assert(cliRun("status").includes("Allowlist: (empty)"));
  assert.match(cliRun("evm-address"), /^0x[0-9a-fA-F]{40}$/);
  assert.match(cliRun("sol-address"), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  // Receive-only derivation exercises the installed treasury dependencies offline.
  assert.match(cliRun("btc-address"), /^bc1q[ac-hj-np-z02-9]{38}$/);
  assert.match(cliRun("doge-address"), /^D[1-9A-HJ-NP-Za-km-z]{33}$/);
  // Run client and optional imports from INSIDE the installed package: no repo resolution.
  const smoke = join(installed, "package-smoke.ts");
  const modules = paths.filter((p: string) => p.startsWith("src/") && !["src/cli.ts", "src/merchant-main.ts"].includes(p));
  writeFileSync(smoke, `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
for (const name of ${JSON.stringify(Object.keys(manifest.dependencies).map(name => name === "@modelcontextprotocol/sdk" ? `${name}/client/index.js` : name === "@noble/curves" ? `${name}/ed25519` : name))}) {
 assert(realpathSync(fileURLToPath(import.meta.resolve(name))).startsWith(realpathSync(${JSON.stringify(consumer)})), 'Dependency escaped isolated consumer: ' + name);
}
for (const file of ${JSON.stringify(modules)}) await import('./' + file);
const client = new Client({ name: 'packed-acceptance', version: '1' });
try {
 await client.connect(new StdioClientTransport({ command: process.execPath, args: ${JSON.stringify([...args, cli, "mcp"])}, cwd: ${JSON.stringify(unrelated)}, env: process.env }));
 const tools = (await client.listTools()).tools.map(t => t.name).sort();
 assert.deepEqual(tools, ['address','balance','kill','send','status','x402_inspect','x402_proof','x402_delegate','x402_pay'].sort());
 const output = JSON.stringify(await client.callTool({ name: 'address', arguments: {} }));
 assert(output.includes(${JSON.stringify(address)}));
 const denied = JSON.stringify(await client.callTool({ name: 'send', arguments: { to: ${JSON.stringify(address)}, amount: 1 } }));
 assert(denied.includes('ALLOWLIST'), 'Expected policy denial, not networking/schema failure: ' + denied);
 for (const body of [output, denied, JSON.stringify(await client.callTool({ name: 'status', arguments: {} }))]) {
  assert(!/"(?:wif|privateKey|masterKeyring|wrapKey|seed)"\\s*:/i.test(body.replaceAll('\\\\"', '"')), 'Private field exposed');
 }
 console.log('MCP discovery/address/status and ALLOWLIST denial passed; optional modules imported');
} finally { await client.close(); }
`);
  const smokeResult = run([process.execPath, ...args, smoke]);
  // Linux must execute the installed launcher itself (permissions + shebang + PATH),
  // not have Bun read its target. Windows retains the explicit-Bun compatibility check.
  // A cwd-local config preserves no-auto-install/preload isolation through the shebang.
  const bin = join(consumer, "node_modules", ".bin", "dogfood-wallet");
  const launcherMarker = join(scratch, "launcher-preload-ran");
  const launcherPreload = join(scratch, "launcher-preload.ts");
  writeFileSync(launcherPreload, `import ${JSON.stringify(deny)};\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(launcherMarker)}, 'fetch-denied');\n`);
  writeFileSync(join(unrelated, "bunfig.toml"), `preload = [${JSON.stringify(launcherPreload.replaceAll("\\", "/"))}]\n[install]\nauto = "disable"\n`);
  const nativeLauncher = process.platform === "linux";
  const launcherRun = (...commands: string[]) => {
    rmSync(launcherMarker, { force: true });
    const output = run(nativeLauncher ? [bin, ...commands] : [process.execPath, bin, ...commands]);
    assert.equal(readFileSync(launcherMarker, "utf8"), "fetch-denied", "Launcher skipped network-denying preload");
    return output;
  };
  assert(launcherRun("--help").includes("Dogfood Wallet"));
  assert.equal(JSON.parse(launcherRun("doctor")).policy.destinations, 0);
  const launcher = nativeLauncher ? "Linux native installed executable: help/doctor (shebang + PATH; fetch denied; auto-install disabled)" : "Explicit Bun installed-bin help/doctor only; native launcher NOT verified on this platform";
  // Deployment entrypoint fails safely without an explicit public payee.
  const merchant = Bun.spawnSync([process.execPath, ...args, join(installed, "src/merchant-main.ts")], { cwd: unrelated, env, timeout: 10000 });
  assert.equal(merchant.exitCode, 1);
  assert(merchant.stderr.toString().includes("DOGFOOD_MERCHANT_PAYTO is required"));
  console.log(JSON.stringify({ package: pack.id, entryCount: pack.entryCount, size: pack.size, unpackedSize: pack.unpackedSize, files: paths, launcher, cli: "absolute installed entrypoint init/address/status/evm-address/sol-address/btc-address/doge-address; merchant missing-payee rejection", smoke: smokeResult }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
