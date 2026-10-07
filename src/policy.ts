export const DEFAULT_MAX_SATS = 10_000;

export type Policy = {
  maxSatsPerTx: number;
  killfileOn: boolean;
};

export type Decision =
  | { ok: true }
  | { ok: false; code: "CAP" | "KILL" | "BAD_ADDRESS" | "BAD_AMOUNT"; message: string };

const P2PKH = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

export function isValidAddress(address: string): boolean {
  return P2PKH.test(address);
}

export function evaluateSend(policy: Policy, amount: number, to: string): Decision {
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
      message: `REJECTED: Destination is not a mainnet P2PKH address.`,
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
  return { ok: true };
}
