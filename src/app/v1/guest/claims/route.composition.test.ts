import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGuestClaimHandoffService,
  InMemoryGuestClaimHandoffStore,
} from "@/lib/app-attest/guest-handoff";

const {
  claimGuestRecovery,
  createConfiguredGuestClaimHandoff,
  createInternalGuestRecoveryCapabilities,
  verifyToken,
} = vi.hoisted(() => ({
  claimGuestRecovery: vi.fn(),
  createConfiguredGuestClaimHandoff: vi.fn(),
  createInternalGuestRecoveryCapabilities: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/app-attest/configured-guest-handoff", () => ({
  createConfiguredGuestClaimHandoff,
}));
vi.mock("@/lib/guest-recovery/internal", () => ({
  createInternalGuestRecoveryCapabilities,
}));

import { POST } from "./route";

const ACCOUNT_USER_ID = "user_claim_owner";
const APP_ID = "TEAMID1234.dev.snaplist.ios";
const APP_ATTEST_KEY_ID = Buffer.alloc(32, 0x61).toString("base64");
const RECOVERY_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_TOKEN = "recovery_v1_abcdefghijklmnopqrstuvwxyz0123456789";
const PHOTO_SET_FINGERPRINT = "b".repeat(64);
const GUEST_USER_ID = `guest_${createHash("sha256")
  .update(APP_ID)
  .update("\0")
  .update(APP_ATTEST_KEY_ID)
  .digest("hex")
  .slice(0, 48)}`;
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

function createOneUseHandoffFixture() {
  const store = new InMemoryGuestClaimHandoffStore({
    attestedKeys: [{
      appId: APP_ID,
      environment: "production",
      keyId: APP_ATTEST_KEY_ID,
    }],
    recoveries: [{
      guestUserId: GUEST_USER_ID,
      photoSetFingerprint: PHOTO_SET_FINGERPRINT,
      recoveryId: RECOVERY_ID,
      recoveryTokenHash: createHash("sha256").update(RECOVERY_TOKEN).digest("hex"),
    }],
  });
  const handoffs = createGuestClaimHandoffService({
    appId: APP_ID,
    clock: () => new Date("2026-08-03T16:00:00.000Z"),
    environment: "production",
    handoffId: () => "22222222-2222-4222-8222-222222222222",
    randomBytes: () => Buffer.alloc(32, 0x62),
    signingKey: Buffer.alloc(32, 0x63),
    store,
    ttlMs: 5 * 60 * 1_000,
  });
  return { handoffs };
}

async function issueOneUseHandoff(
  handoffs: ReturnType<typeof createGuestClaimHandoffService>,
): Promise<string> {
  const issued = await handoffs.issue({
    appId: APP_ID,
    bundleVersion: "1",
    counter: 1,
    environment: "production",
    keyId: APP_ATTEST_KEY_ID,
    kind: "assertion",
    requestHash: "c".repeat(43),
    status: "verified",
    validationCategory: 2,
  }, {
    version: 1,
    purpose: "guest-claim-handoff",
    recoveryId: RECOVERY_ID,
    recoveryToken: RECOVERY_TOKEN,
    photoIdentity: {
      kind: "content_sha256_set_v1",
      fingerprint: PHOTO_SET_FINGERPRINT,
    },
  });
  return issued.handoffToken;
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.test";
  verifyToken.mockResolvedValue({ sub: ACCOUNT_USER_ID });
  claimGuestRecovery.mockResolvedValue(TERMINAL_OUTCOME);
  createInternalGuestRecoveryCapabilities.mockReturnValue({ claim: claimGuestRecovery });
});

afterEach(() => {
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  vi.clearAllMocks();
});

describe("guest claim App Router verifier composition", () => {
  it("claims valid App Attest evidence exactly once through the configured verifier", async () => {
    const { handoffs } = createOneUseHandoffFixture();
    createConfiguredGuestClaimHandoff.mockReturnValue({
      verifyGuestClaimHandoff: handoffs.verify,
    });
    const handoffToken = await issueOneUseHandoff(handoffs);

    expect((await POST(request(handoffToken))).status).toBe(200);
    expect(createConfiguredGuestClaimHandoff).toHaveBeenCalledOnce();
    expect(claimGuestRecovery).toHaveBeenCalledOnce();
    expect(claimGuestRecovery).toHaveBeenCalledWith({
      handoff: {
        guestUserId: GUEST_USER_ID,
        recoveryId: RECOVERY_ID,
        recoveryTokenHash: createHash("sha256").update(RECOVERY_TOKEN).digest("hex"),
      },
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
      targetUserId: ACCOUNT_USER_ID,
    });
  });

  it("refuses replayed App Attest evidence before the claim capability", async () => {
    const { handoffs } = createOneUseHandoffFixture();
    createConfiguredGuestClaimHandoff.mockReturnValue({
      verifyGuestClaimHandoff: handoffs.verify,
    });
    const handoffToken = await issueOneUseHandoff(handoffs);
    await handoffs.verify(handoffToken);

    expect((await POST(request(handoffToken))).status).toBe(401);
    expect(claimGuestRecovery).not.toHaveBeenCalled();
  });

  it("refuses absent or invalid App Attest evidence before the claim capability", async () => {
    const { handoffs } = createOneUseHandoffFixture();
    createConfiguredGuestClaimHandoff.mockReturnValue({
      verifyGuestClaimHandoff: handoffs.verify,
    });

    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("forged-handoff"))).status).toBe(401);
    expect(claimGuestRecovery).not.toHaveBeenCalled();
  });
});
