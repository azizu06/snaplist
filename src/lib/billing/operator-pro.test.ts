import { describe, expect, it } from "vitest";
import {
  OPERATOR_PRO_ALLOWANCE,
  OPERATOR_PRO_PERIOD_KEY,
  ensureOperatorProAllowance,
  isOperatorProUser,
  type OperatorProGrantClient,
} from "./operator-pro";
import { createSupabaseNativeSubscriptionBridge } from "./revenuecat-store";

const REVIEWER = "user_2reviewDemoAccount";
const OWNER = "user_2ownerAccount";
const SELLER = "user_2ordinarySeller";

const GRANTED = {
  SNAPLIST_PRO_OPERATOR_USER_IDS: `${REVIEWER},${OWNER}`,
};

interface RecordedCall {
  functionName: string;
  args: Record<string, unknown>;
}

function recordingClient(
  result: { data: unknown; error: { message: string } | null } = {
    data: true,
    error: null,
  },
): OperatorProGrantClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    rpc(functionName, args) {
      calls.push({ functionName, args });
      return Promise.resolve(result);
    },
  };
}

describe("isOperatorProUser", () => {
  it("grants only the exact authenticated Clerk subjects the operator env names", () => {
    expect(isOperatorProUser(REVIEWER, GRANTED)).toBe(true);
    expect(isOperatorProUser(OWNER, GRANTED)).toBe(true);
    expect(isOperatorProUser(SELLER, GRANTED)).toBe(false);
  });

  it("never matches a prefix, suffix, or case variation of a listed subject", () => {
    for (const candidate of [
      `${REVIEWER}x`,
      REVIEWER.slice(0, -1),
      REVIEWER.toUpperCase(),
      ` ${REVIEWER}`,
      `${REVIEWER} `,
    ]) {
      expect(isOperatorProUser(candidate, GRANTED)).toBe(false);
    }
  });

  it("grants nobody when the env is unset, blank, or absent", () => {
    expect(isOperatorProUser(REVIEWER, {})).toBe(false);
    expect(
      isOperatorProUser(REVIEWER, { SNAPLIST_PRO_OPERATOR_USER_IDS: "" }),
    ).toBe(false);
    expect(
      isOperatorProUser(REVIEWER, { SNAPLIST_PRO_OPERATOR_USER_IDS: "  ,  " }),
    ).toBe(false);
  });

  it("never grants a verified-guest principal, which has no Clerk subject", () => {
    const guestId = `guest_${"a".repeat(48)}`;
    // A guest principal cannot be listed at all — the allowlist rejects the
    // configuration rather than quietly matching an App Attest installation.
    expect(() =>
      isOperatorProUser(guestId, {
        SNAPLIST_PRO_OPERATOR_USER_IDS: guestId,
      }),
    ).toThrowError(/SNAPLIST_PRO_OPERATOR_USER_IDS/);
    expect(isOperatorProUser(guestId, GRANTED)).toBe(false);
  });
});

describe("ensureOperatorProAllowance", () => {
  it("materializes one non-store operator allowance period for a listed subject", async () => {
    const client = recordingClient();

    await expect(
      ensureOperatorProAllowance({
        userId: REVIEWER,
        client,
        env: GRANTED,
      }),
    ).resolves.toBe(true);

    expect(client.calls).toEqual([
      {
        functionName: "grant_operator_ai_item_allowance",
        args: {
          p_user_id: REVIEWER,
          p_allowance: OPERATOR_PRO_ALLOWANCE,
        },
      },
    ]);
  });

  it("issues no grant and no database call for an unlisted subject", async () => {
    const client = recordingClient();

    await expect(
      ensureOperatorProAllowance({ userId: SELLER, client, env: GRANTED }),
    ).resolves.toBe(false);

    expect(client.calls).toEqual([]);
  });

  it("issues no grant and no database call when the env is unset", async () => {
    const client = recordingClient();

    await expect(
      ensureOperatorProAllowance({ userId: REVIEWER, client, env: {} }),
    ).resolves.toBe(false);

    expect(client.calls).toEqual([]);
  });

  it("surfaces a failed grant instead of reporting an entitlement it never wrote", async () => {
    const client = recordingClient({
      data: null,
      error: { message: "permission denied for function" },
    });

    await expect(
      ensureOperatorProAllowance({ userId: OWNER, client, env: GRANTED }),
    ).rejects.toThrowError(/permission denied for function/);
  });

  it("refuses a malformed allowlist rather than falling back to no grant", async () => {
    const client = recordingClient();

    await expect(
      ensureOperatorProAllowance({
        userId: REVIEWER,
        client,
        env: { SNAPLIST_PRO_OPERATOR_USER_IDS: "reviewer@example.com" },
      }),
    ).rejects.toThrowError(/SNAPLIST_PRO_OPERATOR_USER_IDS/);
    expect(client.calls).toEqual([]);
  });

  it("names one stable, non-store period identity so repeat grants stay idempotent", () => {
    expect(OPERATOR_PRO_PERIOD_KEY).toBe("operator-pro-grant");
    expect(OPERATOR_PRO_ALLOWANCE).toBe(10_000);
  });
});

describe("native subscription bridge operator grant", () => {
  interface BridgeCall {
    functionName: string;
    args: Record<string, unknown>;
  }

  function bridgeAdmin(overrides: Record<string, unknown> = {}) {
    const calls: BridgeCall[] = [];
    const responses: Record<string, { data: unknown; error: unknown }> = {
      grant_operator_ai_item_allowance: { data: true, error: null },
      bind_revenuecat_customer: {
        data: [{ transition_state: "not_required", legacy_stripe_status: null }],
        error: null,
      },
      get_verified_ai_item_entitlement: {
        data: [
          {
            billing_source: "included",
            status: "active",
            remaining_items: 9_999,
            period_start: "-infinity",
            period_end: "infinity",
            grace_period_end: null,
            transition_state: "not_required",
            legacy_stripe_status: null,
          },
        ],
        error: null,
      },
      ...overrides,
    };
    return {
      calls,
      rpc(functionName: string, args: Record<string, unknown>) {
        calls.push({ functionName, args });
        return Promise.resolve(
          responses[functionName] ?? { data: null, error: null },
        );
      },
    };
  }

  const CONFIG = {
    iosPublicSdkKey: "appl_public",
    entitlementId: "pro",
    monthlyProductId: "snaplist.pro.monthly",
    webhookSecret: "secret",
    environment: "production" as const,
  };

  it("materializes the operator period before reading the entitlement it will report", async () => {
    const admin = bridgeAdmin();
    const bridge = createSupabaseNativeSubscriptionBridge(
      admin as never,
      CONFIG as never,
      { env: GRANTED },
    );

    const entitlement = await bridge.entitlementFor(REVIEWER);

    expect(admin.calls.map((call) => call.functionName)).toEqual([
      "grant_operator_ai_item_allowance",
      "get_verified_ai_item_entitlement",
    ]);
    expect(admin.calls[0].args).toEqual({
      p_user_id: REVIEWER,
      p_allowance: OPERATOR_PRO_ALLOWANCE,
    });
    // The frozen wire contract is unchanged: no new source reaches the client.
    expect(entitlement.billingSource).toBe("included");
    expect(entitlement.status).toBe("active");
    expect(entitlement.periodStart).toBeNull();
    expect(entitlement.periodEnd).toBeNull();
  });

  it("grants at configuration time too, so a launch reaches run #2 without opening Settings", async () => {
    const admin = bridgeAdmin();
    const bridge = createSupabaseNativeSubscriptionBridge(
      admin as never,
      CONFIG as never,
      { env: GRANTED },
    );

    await bridge.configurationFor(OWNER);

    expect(admin.calls.map((call) => call.functionName)).toEqual([
      "grant_operator_ai_item_allowance",
      "bind_revenuecat_customer",
    ]);
  });

  it("costs an ordinary seller nothing at all", async () => {
    const admin = bridgeAdmin();
    const bridge = createSupabaseNativeSubscriptionBridge(
      admin as never,
      CONFIG as never,
      { env: GRANTED },
    );

    await bridge.entitlementFor(SELLER);
    await bridge.configurationFor(SELLER);

    expect(admin.calls.map((call) => call.functionName)).toEqual([
      "get_verified_ai_item_entitlement",
      "bind_revenuecat_customer",
    ]);
  });

  it("grants nobody when the allowlist is unset", async () => {
    const admin = bridgeAdmin();
    const bridge = createSupabaseNativeSubscriptionBridge(
      admin as never,
      CONFIG as never,
      { env: {} },
    );

    await bridge.entitlementFor(REVIEWER);

    expect(admin.calls.map((call) => call.functionName)).toEqual([
      "get_verified_ai_item_entitlement",
    ]);
  });

  it("leaves an unconfigured deployment exactly as it was", async () => {
    const admin = bridgeAdmin();
    const bridge = createSupabaseNativeSubscriptionBridge(admin as never, null, {
      env: GRANTED,
    });

    const entitlement = await bridge.entitlementFor(REVIEWER);

    expect(entitlement.status).toBe("unconfigured");
    expect(admin.calls).toEqual([]);
    expect(await bridge.configurationFor(REVIEWER)).toEqual({
      configured: false,
      appUserId: REVIEWER,
    });
  });

  it("reports a refused grant instead of quietly answering with the pre-grant entitlement", async () => {
    const admin = bridgeAdmin({
      grant_operator_ai_item_allowance: {
        data: null,
        error: { message: "permission denied for function" },
      },
    });
    const bridge = createSupabaseNativeSubscriptionBridge(
      admin as never,
      CONFIG as never,
      { env: GRANTED },
    );

    await expect(bridge.entitlementFor(REVIEWER)).rejects.toThrowError(
      /permission denied for function/,
    );
    expect(admin.calls.map((call) => call.functionName)).toEqual([
      "grant_operator_ai_item_allowance",
    ]);
  });
});
