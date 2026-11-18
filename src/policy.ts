import {canonicalBtcDest} from './btc-address';
import {canonicalDogeDest} from './doge-address';
import {Utils} from '@bsv/sdk';
export const DEFAULT_MAX_SATS = 10_000;
export const DEFAULT_MAX_SATS_PER_DAY = 50_000;

export type GrydPolicy = { maxPerTxSats: number; maxPerDaySats: number };

/** Missing means legacy gates; present but malformed never enables an exemption. */
export function parseGrydPolicy(raw: unknown): GrydPolicy | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid gryd policy block");
  const value = raw as Record<string, unknown>;
  for (const name of ["maxPerTxSats", "maxPerDaySats"]) {
    if (typeof value[name] !== "number" || !Number.isSafeInteger(value[name]) || value[name] < 0) throw new Error(`Invalid gryd.${name}: nonnegative safe integer required`);
  }
  return { maxPerTxSats: value.maxPerTxSats as number, maxPerDaySats: value.maxPerDaySats as number };
}

export function evaluateGrydBuy(policy: GrydPolicy, killfileOn: boolean, amount: number, spentToday: number): Decision {
  if (killfileOn) return { ok: false, code: "KILL", message: "REJECTED: STOP_SPENDING is on." };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, code: "BAD_AMOUNT", message: "REJECTED: Invalid Gryd purchase amount." };
  if (amount > policy.maxPerTxSats) return { ok: false, code: "CAP", message: "REJECTED: Exceeds gryd.maxPerTxSats." };
  if (spentToday > policy.maxPerDaySats - amount) return { ok: false, code: "DAY", message: "REJECTED: Exceeds gryd.maxPerDaySats." };
  return { ok: true };
}

export type PopnlocksPolicy = { maxPerTxSats: number; maxPerDaySats: number };
export function parsePopnlocksPolicy(raw: unknown): PopnlocksPolicy | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw Error('Invalid popnlocks policy block');
  const p = raw as Record<string, unknown>;
  for (const field of ['maxPerTxSats', 'maxPerDaySats']) {
    if (typeof p[field] !== 'number' || !Number.isSafeInteger(p[field]) || p[field] < 0) throw Error(`Invalid popnlocks.${field}: nonnegative safe integer required`);
  }
  return {maxPerTxSats: p.maxPerTxSats as number, maxPerDaySats: p.maxPerDaySats as number};
}

// OSP door-grant policy: sats that LEAVE the vault when signing Open and Shut
// Protocol transitions (grant payment + miner fee + the 1-sat tip chain;
// door-init/revoke fees count too). Absent block = DISABLED (fail-closed).
export type OspPolicy = { maxSatsPerTx: number; maxSatsPerDay: number | null };
export function parseOspPolicy(raw: unknown): OspPolicy | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw Error('Invalid osp policy block');
  const p = raw as Record<string, unknown>;
  if (typeof p.maxSatsPerTx !== 'number' || !Number.isSafeInteger(p.maxSatsPerTx) || p.maxSatsPerTx < 0)
    throw Error('Invalid osp.maxSatsPerTx: nonnegative safe integer required');
  if (p.maxSatsPerDay !== null && (typeof p.maxSatsPerDay !== 'number' || !Number.isSafeInteger(p.maxSatsPerDay) || p.maxSatsPerDay < 0))
    throw Error('Invalid osp.maxSatsPerDay: nonnegative safe integer or null required');
  return { maxSatsPerTx: p.maxSatsPerTx, maxSatsPerDay: p.maxSatsPerDay };
}

// Agent messaging (S2): absent block = rail DISABLED (fail-closed).
// maxPerDay is a message COUNT cap per UTC day; maxBodyBytes caps the
// plaintext body; recipients is an optional destination allowlist
// (null = unrestricted, [] = deny all). Sats leaving the vault (1-sat tip +
// miner fee) account fee-inclusive against the dedicated "messages" usage
// scope and also feed the bsv / brc181-bsv scopes like any other BSV spend.
export type MessagesPolicy = {
  maxPerDay: number;
  maxBodyBytes: number;
  recipients: string[] | null;
};

/** Strict mainnet P2PKH (version byte 0x00, 20-byte hash). The legacy
 *  isValidAddress regex also accepts P2SH ("3…"); message recipients and
 *  allowlist entries must be plain mainnet P2PKH, same rule as the S1 codec. */
function isMainnetP2pkh(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    const d = Utils.fromBase58Check(address);
    const prefix = d.prefix as number[];
    const data = d.data as number[];
    return prefix.length === 1 && prefix[0] === 0x00 && data.length === 20;
  } catch {
    return false;
  }
}

export function parseMessagesPolicy(raw: unknown): MessagesPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid messages policy block");
  const p = raw as Record<string, unknown>;
  const maxPerDay = p.maxPerDay === undefined ? 100 : p.maxPerDay;
  const maxBodyBytes = p.maxBodyBytes === undefined ? 4096 : p.maxBodyBytes;
  const recipients = p.recipients === undefined ? null : p.recipients;
  if (typeof maxPerDay !== "number" || !Number.isSafeInteger(maxPerDay) || maxPerDay < 1)
    throw new Error("Invalid messages.maxPerDay: positive safe integer required");
  if (typeof maxBodyBytes !== "number" || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new Error("Invalid messages.maxBodyBytes: positive safe integer required");
  if (recipients !== null) {
    if (!Array.isArray(recipients)) throw new Error("Invalid messages.recipients: array of addresses or null required");
    for (const a of recipients) {
      if (!isMainnetP2pkh(a)) throw new Error("Invalid messages.recipients entry: mainnet P2PKH address required");
    }
  }
  return { maxPerDay, maxBodyBytes, recipients: recipients as string[] | null };
}

export function evaluateMessageSend(
  messages: MessagesPolicy | undefined,
  killfileOn: boolean,
  to: string,
  bodyBytes: number,
  countToday: number,
): Decision {
  if (!messages) return { ok: false, code: "DISABLED", message: "REJECTED: agent messaging is disabled — no messages policy configured. Add a messages block to policy.json to enable it." };
  if (killfileOn) return { ok: false, code: "KILL", message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume." };
  if (!isMainnetP2pkh(to)) return { ok: false, code: "BAD_ADDRESS", message: "REJECTED: Recipient is not a mainnet P2PKH address." };
  if (messages.recipients !== null && !messages.recipients.includes(to)) {
    return {
      ok: false,
      code: "ALLOWLIST",
      message: messages.recipients.length === 0
        ? "REJECTED: messages.recipients is empty. A human must allow a recipient first."
        : "REJECTED: Recipient is not on the messages.recipients allowlist.",
    };
  }
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > messages.maxBodyBytes)
    return { ok: false, code: "CAP", message: `REJECTED: Body exceeds messages.maxBodyBytes (${messages.maxBodyBytes} bytes).` };
  if (countToday >= messages.maxPerDay)
    return { ok: false, code: "DAY", message: `REJECTED: Exceeds messages.maxPerDay (${messages.maxPerDay} messages/day, ${countToday} already sent today).` };
  return { ok: true };
}

/** Today's agent-message count for the messages.maxPerDay gate. Unlike the
 *  legacy lenient usage reader this FAILS CLOSED: a corrupt spend-log line
 *  throws instead of silently under-counting toward the cap. */
export function messageCountFromLog(lines: string[], now: Date = new Date()): number {
  const today = utcDay(now);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { kind?: unknown; t?: unknown };
    try {
      row = JSON.parse(trimmed);
    } catch {
      throw new Error("REJECTED: corrupt spend-log line; message count cannot be verified.");
    }
    if (row.kind !== "agent-message") continue;
    if (typeof row.t === "string" && row.t.slice(0, 10) === today) count++;
  }
  return count;
}

/** totalSats = everything leaving the vault in this transition (payment + fee). */
export function evaluateOspTransition(
  osp: OspPolicy | undefined,
  killfileOn: boolean,
  totalSats: number,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  if (!osp) return { ok: false, code: 'DISABLED', message: 'REJECTED: no osp policy configured.' };
  if (killfileOn) return { ok: false, code: 'KILL', message: 'REJECTED: STOP_SPENDING is on.' };
  if (!Number.isSafeInteger(totalSats) || totalSats < 0)
    return { ok: false, code: 'BAD_AMOUNT', message: 'REJECTED: OSP transition total must be a nonnegative safe integer.' };
  if (totalSats > osp.maxSatsPerTx)
    return { ok: false, code: 'CAP', message: 'REJECTED: Exceeds osp.maxSatsPerTx.' };
  if (osp.maxSatsPerDay !== null && usage.spentToday > osp.maxSatsPerDay - totalSats)
    return { ok: false, code: 'DAY', message: 'REJECTED: Exceeds osp.maxSatsPerDay.' };
  return { ok: true };
}

export type Policy = {
  popnlocks?: PopnlocksPolicy;
  btc?: BtcPolicy;
  doge?: DogePolicy;
  gryd?: GrydPolicy;
  osp?: OspPolicy;
  /** Agent messaging rail. Absent = DISABLED (fail-closed). */
  messages?: MessagesPolicy;
  maxSatsPerTx: number;
  maxSatsPerDay: number | null;
  maxSatsLifetime: number | null;
  /** null = unrestricted (legacy). [] = deny all until a human allows an address. */
  allowlist: string[] | null;
  killfileOn: boolean;
  /** Per-asset non-BSV pockets. Absent = DISABLED (fail-closed). */
  evm?: { usdc?: EvmAssetPolicy };
  solana?: { usdc?: EvmAssetPolicy };
  /** BSV<->USDC bridge conversions. Absent = DISABLED (fail-closed). */
  bridge?: BridgePolicy;
};

export type Usage = {
  spentToday: number;
  spentLifetime: number;
};

export type RejectCode =
  | "CAP"
  | "KILL"
  | "BAD_ADDRESS"
  | "BAD_AMOUNT"
  | "ALLOWLIST"
  | "DAY"
  | "LIFETIME"
  | "DISABLED";

// Per-asset pocket policy for non-BSV adapters. Amounts are native base
// units of the asset (USDC: 6 decimals). A missing pocket config means the
// asset is DISABLED — new adapters start locked until a human opts in.
export type EvmAssetPolicy = {
  maxPerTx: number;
  maxPerDay: number | null;
  maxLifetime: number | null;
  /** null = unrestricted; [] = deny all. Compared case-insensitively. */
  allowlist: string[] | null;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type BtcPolicy = Omit<EvmAssetPolicy,'allowlist'> & {
  maxFeeSats:number;
  /** Canonical btc:-prefixed destinations; base58 case is significant. */
  allowlist:string[]|null;
};
export function parseBtcPolicy(raw:unknown):BtcPolicy|undefined {return parseTreasuryPolicy(raw,'btc',canonicalBtcDest);}
function parseTreasuryPolicy(raw:unknown,rail:string,canonical:(address:string)=>string,feeField='maxFeeSats'):BtcPolicy|undefined {
  if(raw===undefined)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid '+rail+' policy block');
  const p=raw as Record<string,unknown>;
  for(const name of ['maxPerTx','maxPerDay','maxLifetime',feeField]) {
    if((name==='maxPerDay'||name==='maxLifetime')&&p[name]===null)continue;
    if(typeof p[name]!=='number'||!Number.isSafeInteger(p[name])||p[name]<0)throw Error('Invalid '+rail+'.'+name);
  }
  if(p.allowlist!==null&&(!Array.isArray(p.allowlist)||!p.allowlist.every(a=>typeof a==='string')))throw Error('Invalid '+rail+'.allowlist');
  const allowlist=p.allowlist===null?null:(p.allowlist as string[]).map(a=>{
    if(!a.startsWith(rail+':')||canonical(a.slice(rail.length+1))!==a)throw Error('Invalid '+rail+'.allowlist: canonical prefixed destination required');
    return a;
  });
  return {maxPerTx:p.maxPerTx as number,maxPerDay:p.maxPerDay as number|null,maxLifetime:p.maxLifetime as number|null,maxFeeSats:p[feeField] as number,allowlist};
}
export function evaluateBtcSend(pocket:BtcPolicy|undefined,killfileOn:boolean,amount:number,to:string,usage:Usage={spentToday:0,spentLifetime:0}):Decision {
 return evaluateTreasurySend(pocket,killfileOn,amount,to,usage,'BTC',canonicalBtcDest);
}
function evaluateTreasurySend(pocket:EvmAssetPolicy|undefined,killfileOn:boolean,amount:number,to:string,usage:Usage,rail:string,canonical:(address:string)=>string):Decision {
  if(!pocket)return {ok:false,code:'DISABLED',message:'REJECTED: no '+rail+' policy configured.'};
  if(killfileOn)return {ok:false,code:'KILL',message:'REJECTED: STOP_SPENDING is on.'};
  if(!Number.isSafeInteger(amount)||amount<=0)return {ok:false,code:'BAD_AMOUNT',message:'REJECTED: native amount must be a positive safe integer.'};
  let address:string;try{address=canonical(to);}catch{return {ok:false,code:'BAD_ADDRESS',message:'REJECTED: Invalid mainnet treasury destination.'};}
  if(pocket.allowlist!==null&&!pocket.allowlist.includes(address))return {ok:false,code:'ALLOWLIST',message:'REJECTED: treasury destination not on allowlist.'};
  if(amount>pocket.maxPerTx)return {ok:false,code:'CAP',message:'REJECTED: Exceeds treasury per-tx cap.'};
  if(pocket.maxPerDay!==null&&usage.spentToday>pocket.maxPerDay-amount)return {ok:false,code:'DAY',message:'REJECTED: Exceeds treasury daily cap.'};
  if(pocket.maxLifetime!==null&&usage.spentLifetime>pocket.maxLifetime-amount)return {ok:false,code:'LIFETIME',message:'REJECTED: Exceeds treasury lifetime cap.'};
  return {ok:true};
}
export type DogePolicy = Omit<BtcPolicy,'maxFeeSats'> & {maxFeeKoinu:number};
export function parseDogePolicy(raw:unknown):DogePolicy|undefined {
  if(raw===undefined)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid doge policy block');
  const p=raw as Record<string,unknown>;
  const parsed=parseTreasuryPolicy(p,'doge',canonicalDogeDest,'maxFeeKoinu')!;
  const {maxFeeSats,...rest}=parsed;return {...rest,maxFeeKoinu:maxFeeSats};
}
export function evaluateDogeSend(pocket:DogePolicy|undefined,killfileOn:boolean,amount:number,to:string,usage:Usage={spentToday:0,spentLifetime:0}):Decision {
 return evaluateTreasurySend(pocket,killfileOn,amount,to,usage,'DOGE',canonicalDogeDest);
}


// Bridge policy: BSV<->USDC conversions between our own vault and our own
// pocket. Absent block = DISABLED (fail-closed). Amounts in sats.
export type BridgePolicy = {
  maxSatsPerSwap: number;
  maxSatsPerDay: number | null;
};

export function evaluateBridgeSwap(
  bridge: BridgePolicy | undefined,
  killfileOn: boolean,
  amountSats: number,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  if (!bridge) {
    return {
      ok: false,
      code: "DISABLED",
      message: "REJECTED: no bridge policy configured. Add a bridge block to policy.json to enable rebalancing.",
    };
  }
  if (!Number.isInteger(amountSats) || amountSats <= 0 || !Number.isSafeInteger(amountSats)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Swap amount must be a positive integer of satoshis (got ${String(amountSats)}).`,
    };
  }
  if (killfileOn) {
    return {
      ok: false,
      code: "KILL",
      message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume.",
    };
  }
  if (amountSats > bridge.maxSatsPerSwap) {
    return {
      ok: false,
      code: "CAP",
      message: `REJECTED: Exceeds bridge cap of ${bridge.maxSatsPerSwap} sats/swap (requested ${amountSats}).`,
    };
  }
  if (bridge.maxSatsPerDay !== null && usage.spentToday + amountSats > bridge.maxSatsPerDay) {
    return {
      ok: false,
      code: "DAY",
      message: `REJECTED: Exceeds bridge daily cap of ${bridge.maxSatsPerDay} sats (bridged ${usage.spentToday}, requested ${amountSats}).`,
    };
  }
  return { ok: true };
}

export function isValidEvmAddress(address: string): boolean {
  return EVM_ADDRESS.test(address);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(address: string): boolean {
  return BASE58.test(address);
}

function evaluatePocket(
  pocket: EvmAssetPolicy | undefined,
  killfileOn: boolean,
  amount: number,
  to: string,
  usage: Usage,
  opts: { name: string; validPayee: (to: string) => boolean; payeeHint: string },
): Decision {
  if (!pocket) {
    return {
      ok: false,
      code: "DISABLED",
      message: `REJECTED: no USDC pocket configured. Add an ${opts.name} block to policy.json to enable it.`,
    };
  }
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Amount must be a positive integer of USDC base units (got ${String(amount)}).`,
    };
  }
  if (killfileOn) {
    return {
      ok: false,
      code: "KILL",
      message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume.",
    };
  }
  if (!opts.validPayee(to)) {
    return { ok: false, code: "BAD_ADDRESS", message: `REJECTED: Payee is not a ${opts.payeeHint} (got ${to}).` };
  }
  if (amount > pocket.maxPerTx) {
    return {
      ok: false,
      code: "CAP",
      message: `REJECTED: Exceeds pocket cap of ${pocket.maxPerTx} base units/tx (requested ${amount}).`,
    };
  }
  if (pocket.allowlist !== null && !pocket.allowlist.some((a) => a.toLowerCase() === to.toLowerCase())) {
    return { ok: false, code: "ALLOWLIST", message: `REJECTED: Payee ${to} is not on the USDC pocket allowlist.` };
  }
  if (pocket.maxPerDay !== null && usage.spentToday + amount > pocket.maxPerDay) {
    return {
      ok: false,
      code: "DAY",
      message: `REJECTED: Exceeds pocket daily cap of ${pocket.maxPerDay} base units (spent ${usage.spentToday}, requested ${amount}).`,
    };
  }
  if (pocket.maxLifetime !== null && usage.spentLifetime + amount > pocket.maxLifetime) {
    return {
      ok: false,
      code: "LIFETIME",
      message: `REJECTED: Exceeds pocket lifetime cap of ${pocket.maxLifetime} base units (spent ${usage.spentLifetime}, requested ${amount}).`,
    };
  }
  return { ok: true };
}

export function evaluateEvmSend(
  pocket: EvmAssetPolicy | undefined,
  killfileOn: boolean,
  amount: number,
  to: string,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  return evaluatePocket(pocket, killfileOn, amount, to, usage, {
    name: "evm.usdc",
    validPayee: isValidEvmAddress,
    payeeHint: "0x EVM address",
  });
}

export function evaluateSolanaSend(
  pocket: EvmAssetPolicy | undefined,
  killfileOn: boolean,
  amount: number,
  to: string,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  return evaluatePocket(pocket, killfileOn, amount, to, usage, {
    name: "solana.usdc",
    validPayee: isValidSolanaAddress,
    payeeHint: "Solana base58 address",
  });
}

export type Decision =
  | { ok: true }
  | { ok: false; code: RejectCode; message: string };

const P2PKH = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

export function isValidAddress(address: string): boolean {
  return P2PKH.test(address);
}

export const MIN_SPLIT_PIECE = 1_000;
export const MAX_SPLIT_OUTPUTS = 20;
export const DEFAULT_SPLIT_PIECE = DEFAULT_MAX_SATS;

export function estimateFee(inputs: number, outputs: number): number {
  return 10 + Math.max(inputs, 1) * 148 + Math.max(outputs, 1) * 34;
}

export function evaluateSplit(policy: Policy, pieceSats: number): Decision {
  if (policy.killfileOn) {
    return {
      ok: false,
      code: "KILL",
      message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume.",
    };
  }
  if (!Number.isInteger(pieceSats) || pieceSats < MIN_SPLIT_PIECE || !Number.isSafeInteger(pieceSats)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Split piece must be an integer of at least ${MIN_SPLIT_PIECE} sats (got ${String(pieceSats)}).`,
    };
  }
  return { ok: true };
}

export type SplitPlan =
  | { ok: true; pieces: number[]; fee: number }
  | { ok: false; code: "INSUFFICIENT"; message: string };

export function planSplit(total: number, pieceSats: number, inputs: number): SplitPlan {
  let n = Math.min(MAX_SPLIT_OUTPUTS, Math.max(2, Math.floor(total / Math.max(pieceSats, MIN_SPLIT_PIECE))));
  while (n >= 2) {
    const fee = estimateFee(inputs, n);
    const spendable = total - fee;
    if (spendable >= n * MIN_SPLIT_PIECE) {
      const base = Math.floor(spendable / n);
      if (base >= MIN_SPLIT_PIECE) {
        const rem = spendable - base * n;
        const pieces = Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
        return { ok: true, pieces, fee };
      }
    }
    n -= 1;
  }
  return {
    ok: false,
    code: "INSUFFICIENT",
    message: `REJECTED: Insufficient funds to split into pocket change (${total} sats).`,
  };
}

export function evaluateSweep(_policy: Policy, to: string): Decision {
  if (!isValidAddress(to)) {
    return {
      ok: false,
      code: "BAD_ADDRESS",
      message: "REJECTED: Destination is not a mainnet P2PKH address.",
    };
  }
  return { ok: true };
}

export function evaluateAllowanceFund(
  policy: Policy,
  amount: number,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Amount must be a positive integer of satoshis (got ${String(amount)}).`,
    };
  }
  if (policy.killfileOn) {
    return {
      ok: false,
      code: "KILL",
      message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume.",
    };
  }
  if (amount > policy.maxSatsPerTx) {
    return {
      ok: false,
      code: "CAP",
      message: `REJECTED: Exceeds cap of ${policy.maxSatsPerTx} sats/tx (requested ${amount}).`,
    };
  }
  if (policy.maxSatsPerDay !== null && usage.spentToday + amount > policy.maxSatsPerDay) {
    return {
      ok: false,
      code: "DAY",
      message: `REJECTED: Exceeds daily cap of ${policy.maxSatsPerDay} sats (spent ${usage.spentToday}, requested ${amount}).`,
    };
  }
  if (policy.maxSatsLifetime !== null && usage.spentLifetime + amount > policy.maxSatsLifetime) {
    return {
      ok: false,
      code: "LIFETIME",
      message: `REJECTED: Exceeds lifetime cap of ${policy.maxSatsLifetime} sats (spent ${usage.spentLifetime}, requested ${amount}).`,
    };
  }
  return { ok: true };
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Signed BRC-181 total_budget gets its own read-only scope per rail over the
// spend log. brc181-bsv is cumulative payout plus miner fees in sats (legacy
// BSV rows count; bridge deposits count). The USDC scopes count only their own
// payment asset: bridge arrival legs are inbound, and facilitator-paid rails
// carry no client fee. Local ordinary/bridge policy scopes remain separate.
const BRC181_SCOPES: Record<string, string[]> = {
  "brc181-btc": ["btc"],
  "brc181-doge": ["doge"],
  "brc181-bsv": ["bsv", "bridge-bsv"],
  "brc181-usdc-base": ["usdc-base"],
  "brc181-usdc-solana": ["usdc-solana"],
};

export function usageFromLog(lines: string[], now: Date = new Date(), asset = "bsv"): Usage {
  const today = utcDay(now);
  let spentToday = 0;
  let spentLifetime = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { t?: string; amount?: unknown; fee?: unknown; kind?: unknown; asset?: unknown };
      if (row.kind === "sweep" || row.kind === "split" || row.kind === "allowance-sweep") continue;
      const rowAsset = typeof row.asset === "string" ? row.asset : "bsv";
      if (asset === "gryd") {
        if (row.kind !== "agent-buy") continue;
      } else if (asset === "osp") {
        if (row.kind !== "osp-grant" && row.kind !== "osp-door-init" && row.kind !== "osp-revoke") continue;
      } else if (asset === "messages") {
        if (row.kind !== "agent-message") continue;
      } else if (!(BRC181_SCOPES[asset] ?? [asset]).includes(rowAsset)) continue;
      let amount =
        typeof row.amount === "number" && Number.isSafeInteger(row.amount) && row.amount > 0 ? row.amount : 0;
      if ((asset === "brc181-bsv" || asset === "brc181-btc" || asset === "brc181-doge" || asset === "osp" || asset === "messages") && typeof row.fee === "number" && Number.isSafeInteger(row.fee) && row.fee > 0) amount += row.fee;
      spentLifetime += amount;
      if (typeof row.t === "string") {
        const day = asset === "gryd" ? (Number.isFinite(Date.parse(row.t)) ? utcDay(new Date(row.t)) : "") : row.t.slice(0, 10);
        if (day === today) spentToday += amount;
      }
    } catch {
      // The new messages scope fails closed on corrupt lines; legacy scopes
      // keep their historical lenient behavior.
      if (asset === "messages") throw new Error("REJECTED: corrupt spend-log line; messages usage cannot be verified.");
      continue;
    }
  }
  return { spentToday, spentLifetime };
}

export function evaluateSend(
  policy: Policy,
  amount: number,
  to: string,
  usage: Usage = { spentToday: 0, spentLifetime: 0 },
): Decision {
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Amount must be a positive integer of satoshis (got ${String(amount)}).`,
    };
  }
  if (!isValidAddress(to)) {
    return {
      ok: false,
      code: "BAD_ADDRESS",
      message: "REJECTED: Destination is not a mainnet P2PKH address.",
    };
  }
  if (policy.killfileOn) {
    return {
      ok: false,
      code: "KILL",
      message: "REJECTED: Killfile STOP_SPENDING is on. Human must delete it to resume.",
    };
  }
  if (policy.allowlist !== null) {
    if (!policy.allowlist.includes(to)) {
      return {
        ok: false,
        code: "ALLOWLIST",
        message:
          policy.allowlist.length === 0
            ? "REJECTED: Allowlist is empty. A human must allow a destination first."
            : "REJECTED: Destination is not on the allowlist.",
      };
    }
  }
  if (amount > policy.maxSatsPerTx) {
    return {
      ok: false,
      code: "CAP",
      message: `REJECTED: Exceeds cap of ${policy.maxSatsPerTx} sats/tx (requested ${amount}).`,
    };
  }
  if (policy.maxSatsPerDay !== null && usage.spentToday + amount > policy.maxSatsPerDay) {
    return {
      ok: false,
      code: "DAY",
      message: `REJECTED: Exceeds daily cap of ${policy.maxSatsPerDay} sats (spent ${usage.spentToday}, requested ${amount}).`,
    };
  }
  if (policy.maxSatsLifetime !== null && usage.spentLifetime + amount > policy.maxSatsLifetime) {
    return {
      ok: false,
      code: "LIFETIME",
      message: `REJECTED: Exceeds lifetime cap of ${policy.maxSatsLifetime} sats (spent ${usage.spentLifetime}, requested ${amount}).`,
    };
  }
  return { ok: true };
}

