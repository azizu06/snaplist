const DELIVERY_LEASE_MS = 5 * 60_000;

export function canRetryDelivery(
  deliveryStatus: string | null | undefined,
  retrying: boolean,
): boolean {
  return !retrying && deliveryStatus !== "delivered";
}

export function deliveryRecoveryLabel(
  deliveryStatus: string | null | undefined,
  deliveryAttemptedAt?: string | null,
  now = new Date(),
): string {
  if (
    requiresDuplicateRiskConfirmation(
      deliveryStatus,
      deliveryAttemptedAt,
      now,
    )
  ) {
    return "Delivery unconfirmed";
  }
  if (deliveryStatus === "sending") return "Delivery pending";
  return "Not delivered";
}

export function requiresDuplicateRiskConfirmation(
  deliveryStatus: string | null | undefined,
  deliveryAttemptedAt?: string | null,
  now = new Date(),
): boolean {
  if (deliveryStatus === "ambiguous") return true;
  if (deliveryStatus !== "sending" || !deliveryAttemptedAt) return false;
  const attemptedAt = Date.parse(deliveryAttemptedAt);
  return (
    Number.isFinite(attemptedAt) &&
    attemptedAt < now.getTime() - DELIVERY_LEASE_MS
  );
}
