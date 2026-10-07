export const DEFAULT_MAX_SATS = 10_000;
export const DEFAULT_MAX_SATS_PER_DAY = 50_000;

export type Policy = {
  maxSatsPerTx: number;
  maxSatsPerDay: number | null;
  maxSatsLifetime: number | null;
  /** null = unrestricted (legacy). [] = deny all until a human allows an address. */
  allowlist: string[] | null;
  killfileOn: boolean;
};

export type Usage = {
  spentToday: number;
  spentLifetime: number;
};

export type RejectCode = "CAP" | "KILL" | "BAD_ADDRESS" | "BAD_AMOUNT" | "ALLOWLIST" | "DAY" | "LIFETIME";

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

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function usageFromLog(lines: string[], now: Date = new Date()): Usage {
  const today = utcDay(now);
  let spentToday = 0;
  let spentLifetime = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { t?: string; amount?: unknown; kind?: unknown };
      if (row.kind === "sweep" || row.kind === "split") continue;
      const amount =
        typeof row.amount === "number" && Number.isSafeInteger(row.amount) && row.amount > 0 ? row.amount : 0;
      spentLifetime += amount;
      if (typeof row.t === "string" && row.t.slice(0, 10) === today) spentToday += amount;
    } catch {
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

