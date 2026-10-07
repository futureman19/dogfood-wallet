import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { DEFAULT_MAX_SATS, type Policy } from "./policy";

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
  writeFileSync(p.policy, `${JSON.stringify({ maxSatsPerTx }, null, 2)}\n`, { mode: 0o644 });
  return { address };
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
  let maxSatsPerTx = DEFAULT_MAX_SATS;
  if (existsSync(p.policy)) {
    const parsed = JSON.parse(readFileSync(p.policy, "utf8")) as { maxSatsPerTx?: number };
    if (typeof parsed.maxSatsPerTx === "number" && parsed.maxSatsPerTx > 0) {
      maxSatsPerTx = parsed.maxSatsPerTx;
    }
  }
  const key = PrivateKey.fromWif(decryptWif(root));
  const address = readFileSync(p.address, "utf8").trim();
  if (key.toAddress() !== address) {
    throw new Error("Vault key does not match address.txt");
  }
  return {
    root,
    address,
    policy: { maxSatsPerTx, killfileOn: existsSync(p.kill) },
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
  killfile: boolean;
  keyPresent: boolean;
} {
  const p = vaultPaths(root);
  const initialized = existsSync(p.enc) && existsSync(p.wrap) && existsSync(p.address);
  const loaded = initialized ? loadVault(root) : null;
  return {
    root,
    address: loaded?.address ?? (existsSync(p.address) ? readFileSync(p.address, "utf8").trim() : ""),
    network: "mainnet",
    cap: loaded?.policy.maxSatsPerTx ?? DEFAULT_MAX_SATS,
    killfile: existsSync(p.kill),
    keyPresent: Boolean(loaded),
  };
}
