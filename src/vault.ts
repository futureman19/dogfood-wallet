import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import {
  DEFAULT_MAX_SATS,
  DEFAULT_MAX_SATS_PER_DAY,
  isValidAddress,
  usageFromLog,
  type EvmAssetPolicy,
  type Policy,
} from "./policy";

export function defaultVaultDir(): string {
  return process.env.DOGFOOD_WALLET_DIR?.trim() || join(homedir(), ".dogfood-wallet");
}

export function vaultPaths(root: string) {
  return {
    enc: join(root, "wif.enc"),
    wrap: join(root, "wrap.key"),
    address: join(root, "address.txt"),
    policy: join(root, "policy.json"),
    kill: join(root, "STOP_SPENDING"),
    log: join(root, "spends.jsonl"),
    brc181: join(root, "brc181.json"),
  };
}

function encryptWif(wif: string, wrap: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrap, iv);
  const ct = Buffer.concat([cipher.update(wif, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptWif(root: string): string {
  const p = vaultPaths(root);
  const wrap = readFileSync(p.wrap);
  const buf = Buffer.from(readFileSync(p.enc, "utf8").trim(), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", wrap, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function initVault(root: string, maxSatsPerTx = DEFAULT_MAX_SATS): { address: string } {
  const p = vaultPaths(root);
  if (existsSync(p.enc) || existsSync(p.wrap)) {
    throw new Error("Vault already initialized. Refusing to overwrite.");
  }
  mkdirSync(root, { recursive: true });
  const key = PrivateKey.fromRandom();
  const address = key.toAddress();
  const wrap = randomBytes(32);
  writeFileSync(p.wrap, wrap, { mode: 0o600 });
  writeFileSync(p.enc, encryptWif(key.toWif(), wrap), { mode: 0o600 });
  writeFileSync(p.address, `${address}\n`, { mode: 0o644 });
  writePolicyFile(root, {
    maxSatsPerTx,
    maxSatsPerDay: DEFAULT_MAX_SATS_PER_DAY,
    maxSatsLifetime: null,
    allowlist: [],
    killfileOn: false,
  });
  return { address };
}

function optionalCap(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return null;
}

function parseStoredPolicy(raw: string, killfileOn: boolean): Policy {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const maxSatsPerTx =
    typeof parsed.maxSatsPerTx === "number" && parsed.maxSatsPerTx > 0 ? parsed.maxSatsPerTx : DEFAULT_MAX_SATS;
  const allowlist = Array.isArray(parsed.allowlist)
    ? parsed.allowlist.filter((a): a is string => typeof a === "string")
    : parsed.allowlist === undefined
      ? null
      : null;
  return {
    maxSatsPerTx,
    maxSatsPerDay: optionalCap(parsed.maxSatsPerDay),
    maxSatsLifetime: optionalCap(parsed.maxSatsLifetime),
    allowlist,
    killfileOn,
    evm: parseEvmBlock(parsed.evm),
  };
}

// Optional evm block: {"evm":{"usdc":{"maxPerTx":1000000,"maxPerDay":null,
// "maxLifetime":null,"allowlist":["0x..."]}}}. Missing block = pocket
// disabled. Present-but-empty usdc block = 1 USDC/tx default, unrestricted
// allowlist (mirrors legacy BSV semantics for a human-written config).
function parseEvmBlock(raw: unknown): { usdc?: EvmAssetPolicy } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usdc = (raw as Record<string, unknown>).usdc;
  if (typeof usdc !== "object" || usdc === null) return {};
  const u = usdc as Record<string, unknown>;
  return {
    usdc: {
      maxPerTx: typeof u.maxPerTx === "number" && u.maxPerTx > 0 ? Math.floor(u.maxPerTx) : 1_000_000,
      maxPerDay: optionalCap(u.maxPerDay),
      maxLifetime: optionalCap(u.maxLifetime),
      allowlist: Array.isArray(u.allowlist)
        ? u.allowlist.filter((a): a is string => typeof a === "string")
        : null,
    },
  };
}

function writePolicyFile(root: string, policy: Policy): void {
  const p = vaultPaths(root);
  writeFileSync(
    p.policy,
    `${JSON.stringify(
      {
        maxSatsPerTx: policy.maxSatsPerTx,
        maxSatsPerDay: policy.maxSatsPerDay,
        maxSatsLifetime: policy.maxSatsLifetime,
        allowlist: policy.allowlist,
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
}

export function allowDestination(root: string, address: string): string[] {
  if (!isValidAddress(address)) throw new Error("Not a mainnet P2PKH address.");
  const loaded = loadVault(root);
  const list = loaded.policy.allowlist === null ? [] : [...loaded.policy.allowlist];
  if (!list.includes(address)) list.push(address);
  writePolicyFile(root, { ...loaded.policy, allowlist: list });
  return list;
}

export function loadUsage(root: string, now = new Date(), asset = "bsv") {
  const p = vaultPaths(root);
  if (!existsSync(p.log)) return usageFromLog([], now, asset);
  return usageFromLog(readFileSync(p.log, "utf8").split(/\r?\n/), now, asset);
}

export type LoadedVault = {
  root: string;
  address: string;
  policy: Policy;
  key: PrivateKey;
};

export function loadVault(root: string): LoadedVault {
  const p = vaultPaths(root);
  if (!existsSync(p.enc) || !existsSync(p.wrap) || !existsSync(p.address)) {
    throw new Error("Vault not initialized. Run: dogfood-wallet init");
  }
  let policy: Policy = {
    maxSatsPerTx: DEFAULT_MAX_SATS,
    maxSatsPerDay: null,
    maxSatsLifetime: null,
    allowlist: null,
    killfileOn: existsSync(p.kill),
  };
  if (existsSync(p.policy)) {
    policy = parseStoredPolicy(readFileSync(p.policy, "utf8"), existsSync(p.kill));
  }
  const key = PrivateKey.fromWif(decryptWif(root));
  const address = readFileSync(p.address, "utf8").trim();
  if (key.toAddress() !== address) {
    throw new Error("Vault key does not match address.txt");
  }
  return {
    root,
    address,
    policy,
    key,
  };
}

export function killVault(root: string): void {
  const p = vaultPaths(root);
  writeFileSync(p.kill, `killed ${new Date().toISOString()}\n`, { mode: 0o644 });
}

export function statusVault(root: string): {
  root: string;
  address: string;
  network: "mainnet";
  cap: number;
  maxSatsPerDay: number | null;
  maxSatsLifetime: number | null;
  allowlist: string[] | null;
  spentToday: number;
  spentLifetime: number;
  killfile: boolean;
  keyPresent: boolean;
} {
  const p = vaultPaths(root);
  const initialized = existsSync(p.enc) && existsSync(p.wrap) && existsSync(p.address);
  const loaded = initialized ? loadVault(root) : null;
  const usage = initialized ? loadUsage(root) : { spentToday: 0, spentLifetime: 0 };
  return {
    root,
    address: loaded?.address ?? (existsSync(p.address) ? readFileSync(p.address, "utf8").trim() : ""),
    network: "mainnet",
    cap: loaded?.policy.maxSatsPerTx ?? DEFAULT_MAX_SATS,
    maxSatsPerDay: loaded?.policy.maxSatsPerDay ?? null,
    maxSatsLifetime: loaded?.policy.maxSatsLifetime ?? null,
    allowlist: loaded?.policy.allowlist ?? null,
    spentToday: usage.spentToday,
    spentLifetime: usage.spentLifetime,
    killfile: existsSync(p.kill),
    keyPresent: Boolean(loaded),
  };
}
