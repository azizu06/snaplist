import { describe, expect, it, vi } from "vitest";
import {
  authorizeDeliveryRetry,
  canRetryDelivery,
  deliveryRecoveryLabel,
  requiresDuplicateRiskConfirmation,
} from "./delivery-recovery";

describe("follow-up delivery recovery", () => {
  it("lets the server decide whether a sending lease is stale", () => {
    expect(canRetryDelivery("sending", false)).toBe(true);
    expect(canRetryDelivery("sending", true)).toBe(false);
  });

  it("keeps acknowledgement-less delivery semantically ambiguous", () => {
    expect(deliveryRecoveryLabel("ambiguous")).toBe("Delivery unconfirmed");
    expect(requiresDuplicateRiskConfirmation("ambiguous")).toBe(true);
    expect(requiresDuplicateRiskConfirmation("failed")).toBe(false);
  });

  it("treats an expired sending lease as delivery-unconfirmed", () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const attemptedAt = "2026-07-13T11:54:00.000Z";

    expect(deliveryRecoveryLabel("sending", attemptedAt, now)).toBe(
      "Delivery unconfirmed",
    );
    expect(
      requiresDuplicateRiskConfirmation("sending", attemptedAt, now),
    ).toBe(true);
    expect(
      requiresDuplicateRiskConfirmation(
        "sending",
        "2026-07-13T11:56:00.000Z",
        now,
      ),
    ).toBe(false);
  });

  it("requires explicit consent before authorizing a stale sending retry", () => {
    const confirm = vi.fn(() => false);
    const decision = authorizeDeliveryRetry(
      "sending",
      "2026-07-13T11:54:00.000Z",
      confirm,
      new Date("2026-07-13T12:00:00.000Z"),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(decision).toEqual({
      proceed: false,
      confirmDuplicateRisk: false,
    });
  });
});
