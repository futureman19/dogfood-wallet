import { describe, expect, test } from "bun:test";
import { normalizeBudget, budgetFromDrag, checkDemo } from "./bowlDemo.js";
describe("isolated marketing bowl demo", () => {
  test("budget clamps and rounds to whole 1000-sat steps", () => {
    expect(normalizeBudget(-1000)).toBe(0);
    expect(normalizeBudget(150000)).toBe(100000);
    expect(normalizeBudget(51499)).toBe(51000);
    expect(normalizeBudget(51500)).toBe(52000);
  });
  test("drag left reduces, right increases, and bounds hold", () => {
    expect(budgetFromDrag(50000, 40, 200)).toBe(70000);
    expect(budgetFromDrag(50000, -40, 200)).toBe(30000);
    expect(budgetFromDrag(50000, -400, 200)).toBe(0);
    expect(budgetFromDrag(50000, 400, 200)).toBe(100000);
  });
  test("empty allowlist always fails closed", () => {
    expect(
      checkDemo({ budget: 100000, spent: 0, allowed: false, amount: 1000 }).ok,
    ).toBe(false);
  });
  test("per-transaction cap is separate from daily budget", () => {
    expect(
      checkDemo({ budget: 100000, spent: 0, allowed: true, amount: 12000 }).ok,
    ).toBe(false);
  });
  test("daily cap includes prior simulated usage and equality is allowed", () => {
    expect(
      checkDemo({ budget: 5000, spent: 4000, allowed: true, amount: 1000 }).ok,
    ).toBe(true);
    expect(
      checkDemo({ budget: 5000, spent: 5000, allowed: true, amount: 1000 }).ok,
    ).toBe(false);
    expect(
      checkDemo({ budget: 0, spent: 0, allowed: true, amount: 1000 }).ok,
    ).toBe(false);
  });
});
