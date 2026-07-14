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
});
