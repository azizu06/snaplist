/** A benchmark-only spend fence. Unknown outcomes keep their whole reservation. */
export function createBenchmarkBudget(limitUsd: number) {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error("Invalid budget");
  let charged = 0;
  let held = 0;
  return {
    chargedUsd: () => charged,
    heldUsd: () => held,
    reserve(worstCaseUsd: number) {
      if (!Number.isFinite(worstCaseUsd) || worstCaseUsd <= 0) throw new Error("Invalid reservation");
      if (charged + held + worstCaseUsd > limitUsd) return null;
      held += worstCaseUsd;
      let settled = false;
      return {
        settle(actualUsd: number) {
          if (settled || !Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > worstCaseUsd) {
            throw new Error("Invalid settlement");
          }
          settled = true;
          held -= worstCaseUsd;
          charged += actualUsd;
        },
      };
    },
  };
}
