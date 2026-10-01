import { describe, expect, it } from "vitest";
import { createBenchmarkBudget } from "./benchmark-model-budget";

describe("model benchmark spend boundary", () => {
  it("refuses another paid request when its worst-case charge exceeds the remaining allowance", () => {
    const budget = createBenchmarkBudget(1.25);
    const first = budget.reserve(0.8);
    expect(first).not.toBeNull();
    expect(budget.reserve(0.5)).toBeNull();
    first!.settle(0.1);
    expect(budget.reserve(0.5)).not.toBeNull();
    expect(budget.chargedUsd()).toBe(0.1);
  });
  it("retains unknown spend and rejects invalid or duplicate settlements", () => {
    const budget = createBenchmarkBudget(1.25);
    const unknown = budget.reserve(0.8)!;
    expect(budget.reserve(0.5)).toBeNull();
    expect(() => unknown.settle(-1)).toThrow();
    expect(() => unknown.settle(0.9)).toThrow();
    unknown.settle(0.2);
    expect(() => unknown.settle(0.2)).toThrow();
    expect(budget.chargedUsd()).toBe(0.2);
    expect(budget.heldUsd()).toBe(0);
    expect(() => budget.reserve(Number.NaN)).toThrow();
    expect(() => createBenchmarkBudget(-1)).toThrow();
  });
});
