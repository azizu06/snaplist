import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RevenueCatCustomerIdentity,
  RevenueCatEntitlementStore,
  RevenueCatServerConfig,
  VerifiedStoreKitPeriod,
} from "./revenuecat";

export interface NativeRevenueCatConfiguration {
  configured: boolean;
  appUserId: string;
  publicSdkKey?: string;
  entitlementId?: string;
  monthlyProductId?: string;
  offeringId?: string;
  transitionState?: "not_required" | "required" | "reconciled";
  legacyStripeStatus?: string | null;
}

export interface VerifiedAiItemEntitlement {
  billingSource: "included" | "storekit" | "none";
  status:
    | "included"
    | "active"
    | "grace"
    | "billing_retry"
    | "expired"
    | "revoked"
    | "refunded"
    | "ambiguous"
    | "unconfigured";
  remainingItems: number;
  periodStart: string | null;
  periodEnd: string | null;
  gracePeriodEnd: string | null;
  transitionState: "not_required" | "required" | "reconciled" | null;
  legacyStripeStatus: string | null;
}

export interface NativeSubscriptionBridge {
  configurationFor(userId: string): Promise<NativeRevenueCatConfiguration>;
  entitlementFor(userId: string): Promise<VerifiedAiItemEntitlement>;
}

function rowFrom(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0];
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

function finiteTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "infinity" || normalized === "-infinity" ? null : value;
}

export function createSupabaseRevenueCatEntitlementStore(
  admin: SupabaseClient,
): RevenueCatEntitlementStore {
  return {
    async resolveCustomer(identity: RevenueCatCustomerIdentity) {
      const { data, error } = await admin.rpc("resolve_revenuecat_customer", {
        p_original_app_user_id: identity.originalAppUserId,
        p_original_transaction_id: identity.originalTransactionId,
        p_revenuecat_app_user_id: identity.appUserId,
      });
      if (error) throw error;
      const row = rowFrom(data);
      if (!row || typeof row.user_id !== "string") return null;
      if (
        row.transition_state !== "not_required" &&
        row.transition_state !== "required" &&
        row.transition_state !== "reconciled"
      ) {
        throw new Error("RevenueCat customer resolution returned an invalid transition state.");
      }
      return {
        userId: row.user_id,
        transitionState: row.transition_state,
      };
    },

    async recordPeriod(period: VerifiedStoreKitPeriod) {
      const { data, error } = await admin.rpc(
        "record_verified_revenuecat_ai_item_period",
        {
          p_allowance: period.allowance,
          p_environment: period.environment,
          p_event_created_at: period.eventCreatedAt,
          p_event_id: period.eventId,
          p_event_type: period.eventType,
          p_expires_date: period.expiresDate,
          p_grace_expires_date: period.graceExpiresDate,
          p_original_transaction_id: period.originalTransactionId,
          p_period_key: period.periodKey,
          p_period_start: period.periodStart,
          p_revenuecat_app_user_id: period.userId,
          p_state: period.state,
          p_user_id: period.userId,
        },
      );
      if (error) throw error;
      return data === true;
    },

    async requireReconciliation(input) {
      const { error } = await admin.rpc("require_revenuecat_reconciliation", {
        p_event_created_at: input.eventCreatedAt,
        p_environment: input.environment,
        p_event_id: input.eventId,
        p_event_type: input.eventType,
        p_original_app_user_id: input.identity.originalAppUserId,
        p_original_transaction_id: input.identity.originalTransactionId,
        p_revenuecat_app_user_id: input.identity.appUserId,
      });
      if (error) throw error;
    },
  };
}

export function createSupabaseNativeSubscriptionBridge(
  admin: SupabaseClient,
  config: RevenueCatServerConfig | null,
): NativeSubscriptionBridge {
  return {
    async configurationFor(userId) {
      if (!config?.iosPublicSdkKey) return { configured: false, appUserId: userId };
      const { data, error } = await admin.rpc("bind_revenuecat_customer", {
        p_revenuecat_app_user_id: userId,
        p_user_id: userId,
      });
      if (error) throw error;
      const row = rowFrom(data);
      if (!row || typeof row.transition_state !== "string") {
        throw new Error("RevenueCat customer binding returned no state.");
      }
      return {
        configured: true,
        appUserId: userId,
        publicSdkKey: config.iosPublicSdkKey,
        entitlementId: config.entitlementId,
        monthlyProductId: config.monthlyProductId,
        ...(config.offeringId ? { offeringId: config.offeringId } : {}),
        transitionState: row.transition_state as
          | "not_required"
          | "required"
          | "reconciled",
        legacyStripeStatus:
          typeof row.legacy_stripe_status === "string"
            ? row.legacy_stripe_status
            : null,
      };
    },

    async entitlementFor(userId) {
      if (!config) {
        return {
          billingSource: "none",
          status: "unconfigured",
          remainingItems: 0,
          periodStart: null,
          periodEnd: null,
          gracePeriodEnd: null,
          transitionState: null,
          legacyStripeStatus: null,
        };
      }
      const { data, error } = await admin.rpc(
        "get_verified_ai_item_entitlement",
        { p_user_id: userId },
      );
      if (error) throw error;
      const row = rowFrom(data);
      if (!row) throw new Error("Verified AI-item entitlement returned no state.");
      return {
        billingSource: row.billing_source as VerifiedAiItemEntitlement["billingSource"],
        status: row.status as VerifiedAiItemEntitlement["status"],
        remainingItems: Number(row.remaining_items),
        periodStart: finiteTimestamp(row.period_start),
        periodEnd: finiteTimestamp(row.period_end),
        gracePeriodEnd: finiteTimestamp(row.grace_period_end),
        transitionState:
          typeof row.transition_state === "string"
            ? (row.transition_state as VerifiedAiItemEntitlement["transitionState"])
            : null,
        legacyStripeStatus:
          typeof row.legacy_stripe_status === "string"
            ? row.legacy_stripe_status
            : null,
      };
    },
  };
}
