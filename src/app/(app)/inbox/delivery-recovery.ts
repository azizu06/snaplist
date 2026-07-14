export function canRetryDelivery(
  deliveryStatus: string | null | undefined,
  retrying: boolean,
): boolean {
  return !retrying && deliveryStatus !== "delivered";
}

export function deliveryRecoveryLabel(
  deliveryStatus: string | null | undefined,
): string {
  if (deliveryStatus === "ambiguous") return "Delivery unconfirmed";
  if (deliveryStatus === "sending") return "Delivery pending";
  return "Not delivered";
}

export function requiresDuplicateRiskConfirmation(
  deliveryStatus: string | null | undefined,
): boolean {
  return deliveryStatus === "ambiguous";
}
