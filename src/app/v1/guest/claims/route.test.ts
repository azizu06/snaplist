import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  claimGuestRecovery,
  clerkPrincipal,
  createInternalGuestRecoveryCapabilities,
  unavailableWorker,
  verifyGuestClaimHandoff,
} = vi.hoisted(() => ({
  claimGuestRecovery: vi.fn(),
  clerkPrincipal: vi.fn(),
  createInternalGuestRecoveryCapabilities: vi.fn(),
  unavailableWorker: vi.fn(() => ({ consume: vi.fn() })),
  verifyGuestClaimHandoff: vi.fn(),
}));
vi.mock("@/lib/guest-recovery/internal", () => ({
  createInternalGuestRecoveryCapabilities,
}));
vi.mock("../../mobile-api-composition", () => ({
  clerkPrincipal,
  unavailableWorker,
  verifyGuestClaimHandoff,
}));
import { POST } from "./route";

const ACCOUNT_USER_ID = "user_claim_owner";
const VERIFIED_HANDOFF = {
  guestUserId: `guest_${"a".repeat(48)}`,
  recoveryId: "11111111-1111-4111-8111-111111111111",
  recoveryTokenHash: "b".repeat(64),
};
const TERMINAL_OUTCOME = {
  draftId: "44444444-4444-4444-8444-444444444444",
  itemId: "55555555-5555-4555-8555-555555555555",
  outcome: "expired" as const,
  purgeLocalRecovery: true as const,
  runId: "66666666-6666-4666-8666-666666666666",
};
function request(handoffToken?: string, idempotencyKey = "77777777-7777-4777-8777-777777777777") {
  const headers = new Headers({
    authorization: "Bearer signed-clerk-jwt",
    "idempotency-key": idempotencyKey,
  });
  if (handoffToken) headers.set("x-snaplist-guest-handoff", handoffToken);
  return new Request("https://snaplist.test/v1/guest/claims", { headers, method: "POST" });
}

beforeEach(() => {
  clerkPrincipal.mockResolvedValue({ kind: "clerk", userId: ACCOUNT_USER_ID });
  claimGuestRecovery.mockResolvedValue(TERMINAL_OUTCOME);
  createInternalGuestRecoveryCapabilities.mockReturnValue({ claim: claimGuestRecovery });
});

afterEach(() => vi.clearAllMocks());

describe("guest claim App Router seam", () => {
  it("claims a verified App Attest handoff exactly once", async () => {
    verifyGuestClaimHandoff.mockResolvedValue(VERIFIED_HANDOFF);

    expect((await POST(request("verified-handoff"))).status).toBe(200);
    expect(claimGuestRecovery).toHaveBeenCalledOnce();
    expect(claimGuestRecovery).toHaveBeenCalledWith({
      handoff: VERIFIED_HANDOFF,
      bearerToken: "signed-clerk-jwt",
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
      targetUserId: ACCOUNT_USER_ID,
    });
  });

  it("refuses replayed evidence before another claim or credit movement", async () => {
    verifyGuestClaimHandoff
      .mockResolvedValueOnce(VERIFIED_HANDOFF)
      .mockRejectedValueOnce(new Error("replayed handoff"));

    expect((await POST(request("one-use-handoff"))).status).toBe(200);
    expect((await POST(request("one-use-handoff", "88888888-8888-4888-8888-888888888888"))).status).toBe(401);
    expect(claimGuestRecovery).toHaveBeenCalledOnce();
  });

  it("refuses absent or invalid evidence before reaching the claim capability", async () => {
    expect((await POST(request())).status).toBe(401);
    expect(verifyGuestClaimHandoff).not.toHaveBeenCalled();
    expect(claimGuestRecovery).not.toHaveBeenCalled();

    verifyGuestClaimHandoff.mockRejectedValue(new Error("invalid handoff"));
    expect((await POST(request("forged-handoff"))).status).toBe(401);
    expect(claimGuestRecovery).not.toHaveBeenCalled();
  });

  it("sends only the Clerk principal to the RLS claim capability", async () => {
    verifyGuestClaimHandoff.mockResolvedValue(VERIFIED_HANDOFF);
    const rlsScopedClaim = vi.fn(async ({ targetUserId }: { targetUserId: string }) => {
      if (targetUserId !== ACCOUNT_USER_ID) throw new Error("RLS denied claim");
      return TERMINAL_OUTCOME;
    });
    createInternalGuestRecoveryCapabilities.mockReturnValue({ claim: rlsScopedClaim });

    expect((await POST(request("verified-handoff"))).status).toBe(200);
    expect(rlsScopedClaim).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: ACCOUNT_USER_ID,
    }));
  });
});
