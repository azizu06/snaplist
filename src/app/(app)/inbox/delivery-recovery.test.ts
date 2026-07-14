import { describe, expect, it } from "vitest";
import {
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
});
