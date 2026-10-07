// Marketing-only policy illustration. No vault, signing, storage, or transport.
export const MAX_BUDGET = 100000;
export const STEP = 1000;
export const PER_TX = 10000;
export const DEFAULT_BUDGET = 50000;
export const formatSats = (value) => value.toLocaleString("en-US");
export function normalizeBudget(value) {
  return Math.max(0, Math.min(MAX_BUDGET, Math.round(value / STEP) * STEP));
}
export function budgetFromDrag(startBudget, deltaX, width) {
  return normalizeBudget(
    startBudget + (deltaX / Math.max(1, width)) * MAX_BUDGET,
  );
}
export function checkDemo({ budget, spent, allowed, amount }) {
  if (!allowed)
    return { ok: false, reason: "Empty allowlist. Human approval required." };
  if (amount > PER_TX)
    return { ok: false, reason: "Request exceeds the 10,000 sats/tx cap." };
  if (spent + amount > budget)
    return { ok: false, reason: "Daily cap reached. Request denied." };
  return { ok: true, reason: "Policy permits this example. No payment sent." };
}
