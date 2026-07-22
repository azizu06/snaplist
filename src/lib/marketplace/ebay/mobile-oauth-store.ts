import "server-only";

import { createClient } from "@supabase/supabase-js";
import {
  createMobileEbayOauthOperations,
  type MobileEbayOauthSessionStore,
  type MobileEbayOauthSessionStatus,
} from "./mobile-oauth";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: invalid database result`);
  }
  return value as JsonRecord;
}

function requiredString(
  value: unknown,
  context: string,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}: invalid ${field}`);
  }
  return value;
}

function requiredSessionStatus(
  value: unknown,
  context: string,
): MobileEbayOauthSessionStatus {
  if (![
    "pending",
    "completing",
    "connected",
    "declined",
    "cancelled",
    "expired",
    "failed",
  ].includes(value as string)) {
    throw new Error(`${context}: invalid status`);
  }
  return value as MobileEbayOauthSessionStatus;
}

function rpcFailure(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export interface ConfiguredMobileEbayOauthInput {
  supabaseURL: string;
  secretKey: string;
}

export function createSupabaseMobileEbayOauthSessionStore(
  input: ConfiguredMobileEbayOauthInput,
): MobileEbayOauthSessionStore {
  if (!input.secretKey.startsWith("sb_secret_")) {
    throw new Error("Mobile eBay OAuth requires a current Supabase secret key.");
  }

  const serviceClient = createClient(input.supabaseURL, input.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tenantClient = (bearerToken: string) =>
    createClient(input.supabaseURL, input.secretKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });

  const store: MobileEbayOauthSessionStore = {
    async createOrReplaySession(sessionInput) {
      const { data, error } = await tenantClient(sessionInput.bearerToken).rpc(
        "create_mobile_ebay_oauth_session",
        {
          p_proposed_session_id: sessionInput.proposedSessionId,
          p_idempotency_key: sessionInput.idempotencyKey,
        },
      );
      rpcFailure("Failed to create eBay OAuth session", error);
      const result = record(data, "Failed to create eBay OAuth session");
      const userId = requiredString(
        result.user_id,
        "Failed to create eBay OAuth session",
        "user_id",
      );
      if (userId !== sessionInput.userId) {
        throw new Error("Failed to create eBay OAuth session: tenant mismatch");
      }
      return {
        sessionId: requiredString(
          result.session_id,
          "Failed to create eBay OAuth session",
          "session_id",
        ),
        userId,
        expiresAt: requiredString(
          result.expires_at,
          "Failed to create eBay OAuth session",
          "expires_at",
        ),
      };
    },

    async getSession(sessionId) {
      const { data, error } = await serviceClient.rpc(
        "read_mobile_ebay_oauth_session",
        { p_session_id: sessionId },
      );
      rpcFailure("Failed to read eBay OAuth session", error);
      if (data == null) return null;
      const result = record(data, "Failed to read eBay OAuth session");
      return {
        sessionId: requiredString(
          result.session_id,
          "Failed to read eBay OAuth session",
          "session_id",
        ),
        userId: requiredString(
          result.user_id,
          "Failed to read eBay OAuth session",
          "user_id",
        ),
        expiresAt: requiredString(
          result.expires_at,
          "Failed to read eBay OAuth session",
          "expires_at",
        ),
        status: requiredSessionStatus(
          result.status,
          "Failed to read eBay OAuth session",
        ),
      };
    },

    async finishSession(sessionInput) {
      const { data, error } = await serviceClient.rpc(
        "finish_mobile_ebay_oauth_session",
        {
          p_session_id: sessionInput.sessionId,
          p_expected_user_id: sessionInput.userId,
          p_outcome: sessionInput.outcome,
          p_finished_at: sessionInput.finishedAt,
        },
      );
      rpcFailure("Failed to finish eBay OAuth session", error);
      const result = record(data, "Failed to finish eBay OAuth session");
      const kind = result.kind;
      if (
        kind !== "finished"
        && kind !== "replayed"
        && kind !== "in_progress"
        && kind !== "wrong_tenant"
      ) {
        throw new Error("Failed to finish eBay OAuth session: invalid outcome");
      }
      if (kind === "wrong_tenant" || kind === "in_progress") return { kind };
      const outcome = requiredString(
        result.outcome,
        "Failed to finish eBay OAuth session",
        "outcome",
      );
      if (![
        "connected",
        "declined",
        "cancelled",
        "expired",
        "failed",
      ].includes(outcome)) {
        throw new Error("Failed to finish eBay OAuth session: invalid replay outcome");
      }
      return {
        kind,
        outcome: outcome as "connected" | "declined" | "cancelled" | "expired" | "failed",
      };
    },

    async beginSession(sessionInput) {
      const { data, error } = await serviceClient.rpc(
        "begin_mobile_ebay_oauth_session",
        {
          p_session_id: sessionInput.sessionId,
          p_expected_user_id: sessionInput.userId,
          p_started_at: sessionInput.startedAt,
        },
      );
      rpcFailure("Failed to begin eBay OAuth callback", error);
      const result = record(data, "Failed to begin eBay OAuth callback");
      if (result.kind === "claimed") {
        return {
          kind: "claimed" as const,
          leaseToken: requiredString(
            result.lease_token,
            "Failed to begin eBay OAuth callback",
            "lease_token",
          ),
        };
      }
      if (result.kind === "replayed") {
        const outcome = requiredString(
          result.outcome,
          "Failed to begin eBay OAuth callback",
          "outcome",
        );
        if (![
          "connected",
          "declined",
          "cancelled",
          "expired",
          "failed",
        ].includes(outcome)) {
          throw new Error("Failed to begin eBay OAuth callback: invalid replay outcome");
        }
        return {
          kind: "replayed" as const,
          outcome: outcome as "connected" | "declined" | "cancelled" | "expired" | "failed",
        };
      }
      if (
        result.kind === "wrong_tenant"
        || result.kind === "expired"
        || result.kind === "in_progress"
      ) {
        return { kind: result.kind };
      }
      throw new Error("Failed to begin eBay OAuth callback: invalid outcome");
    },

    async completeSession(sessionInput) {
      const { data, error } = await serviceClient.rpc(
        "complete_mobile_ebay_oauth_session",
        {
          p_session_id: sessionInput.sessionId,
          p_expected_user_id: sessionInput.userId,
          p_lease_token: sessionInput.leaseToken,
          p_ebay_user_id: sessionInput.ebayUserId,
          p_ebay_username: sessionInput.ebayUsername,
          p_refresh_token_enc: sessionInput.refreshTokenEnc,
          p_access_token_enc: sessionInput.accessTokenEnc,
          p_access_token_expires_at: sessionInput.accessTokenExpiresAt,
          p_scopes: sessionInput.scopes,
          p_completed_at: sessionInput.completedAt,
        },
      );
      rpcFailure("Failed to complete eBay OAuth callback", error);
      const result = record(data, "Failed to complete eBay OAuth callback");
      const kind = result.kind;
      if (kind !== "connected" && kind !== "replayed" && kind !== "wrong_tenant") {
        throw new Error("Failed to complete eBay OAuth callback: invalid outcome");
      }
      if (kind === "replayed") {
        const outcome = requiredString(
          result.outcome,
          "Failed to complete eBay OAuth callback",
          "outcome",
        );
        if (![
          "connected",
          "declined",
          "cancelled",
          "expired",
          "failed",
        ].includes(outcome)) {
          throw new Error(
            "Failed to complete eBay OAuth callback: invalid replay outcome",
          );
        }
        return {
          kind,
          outcome: outcome as
            | "connected"
            | "declined"
            | "cancelled"
            | "expired"
            | "failed",
        };
      }
      return { kind };
    },

    async failSession(sessionInput) {
      const { data, error } = await serviceClient.rpc(
        "fail_mobile_ebay_oauth_session",
        {
          p_session_id: sessionInput.sessionId,
          p_expected_user_id: sessionInput.userId,
          p_lease_token: sessionInput.leaseToken,
          p_failed_at: sessionInput.failedAt,
        },
      );
      rpcFailure("Failed to fail eBay OAuth callback", error);
      const result = record(data, "Failed to fail eBay OAuth callback");
      const kind = result.kind;
      if (
        kind !== "finished"
        && kind !== "replayed"
        && kind !== "wrong_tenant"
      ) {
        throw new Error("Failed to fail eBay OAuth callback: invalid outcome");
      }
      if (kind === "wrong_tenant") return { kind };
      const outcome = requiredString(
        result.outcome,
        "Failed to fail eBay OAuth callback",
        "outcome",
      );
      if (![
        "connected",
        "declined",
        "cancelled",
        "expired",
        "failed",
      ].includes(outcome)) {
        throw new Error(
          "Failed to fail eBay OAuth callback: invalid replay outcome",
        );
      }
      return {
        kind,
        outcome: outcome as
          | "connected"
          | "declined"
          | "cancelled"
          | "expired"
          | "failed",
      };
    },
  };

  return store;
}

export function createConfiguredMobileEbayOauthOperations(
  input: ConfiguredMobileEbayOauthInput,
) {
  return createMobileEbayOauthOperations({
    store: createSupabaseMobileEbayOauthSessionStore(input),
  });
}
