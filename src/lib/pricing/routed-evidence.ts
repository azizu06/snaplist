export interface RoutedSoldCompEvidence {
  url: string;
  soldAt?: number;
}

export interface RoutedSoldEvidence {
  observedAt: number;
  comps: readonly Readonly<RoutedSoldCompEvidence>[];
}

const providerSoldEvidence = new WeakMap<
  object,
  readonly Readonly<RoutedSoldCompEvidence>[]
>();
const routedSoldEvidence = new WeakMap<object, Readonly<RoutedSoldEvidence>>();

function immutableEvidence(
  comps: readonly RoutedSoldCompEvidence[],
): readonly Readonly<RoutedSoldCompEvidence>[] {
  return Object.freeze(
    comps.map((comp) =>
      Object.freeze({
        url: comp.url,
        ...(comp.soldAt !== undefined ? { soldAt: comp.soldAt } : {}),
      }),
    ),
  );
}

/** Internal sold-provider seam: attach the exact comps cited by one result. */
export function enrollProviderSoldEvidence(
  result: object,
  comps: readonly RoutedSoldCompEvidence[],
): void {
  providerSoldEvidence.set(result, immutableEvidence(comps));
}

/** Router seam: promote only provider-enrolled evidence to routed authority. */
export function enrollRoutedSoldEvidence(result: object): void {
  const evidence = providerSoldEvidence.get(result);
  if (evidence) {
    routedSoldEvidence.set(
      result,
      Object.freeze({ observedAt: Date.now(), comps: evidence }),
    );
  }
}

/** Immutable evidence available only for the exact object returned by the router. */
export function routedSoldCompEvidence(
  value: unknown,
): Readonly<RoutedSoldEvidence> | null {
  if (typeof value !== "object" || value === null) return null;
  const evidence = routedSoldEvidence.get(value);
  return evidence
    ? Object.freeze({
        observedAt: evidence.observedAt,
        comps: immutableEvidence(evidence.comps),
      })
    : null;
}
