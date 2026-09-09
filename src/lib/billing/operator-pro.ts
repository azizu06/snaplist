import { getProOperatorUserIds } from "@/lib/env";

/**
 * Operator SnapList Pro grant (#1077).
 *
 * The App Review demo account and the owner must be able to exercise every
 * feature without a purchase. The grant is deliberately NOT a fabricated
 * RevenueCat customer or StoreKit period: it materializes its own
 * `ai_item_allowance_periods` row with `source = 'operator'`, so the RevenueCat
 * webhook, the customer-binding resolver, and the legacy-environment quarantine
 * — all of which filter on `source = 'storekit'` — can never mistake it for a
 * store purchase, and reconciliation never has a transaction to reconcile.
 *
 * The ledger is untouched otherwise: every operator run still reserves and
 * settles an `ai_item_credit_reservations` row against this period, so the eval
 * harness keeps seeing the runs.
 *
 * Membership is decided ONLY by the authenticated Clerk subject (the same value
 * RLS enforces as `user_id`) against a server-side env list. Nothing a client
 * sends participates.
 */

/** One stable period identity per operator, so repeat grants are idempotent. */
export const OPERATOR_PRO_PERIOD_KEY = "operator-pro-grant";

/**
 * The ledger caps an allowance at 10000. That ceiling is the honest way to say
 * "never exhausted for a reviewer" without inventing an infinite quota the
 * schema cannot express: two operators cannot approach it, and if one somehow
 * did, they would fall through to the ordinary paid rules rather than to an
 * unaudited bypass.
 */
export const OPERATOR_PRO_ALLOWANCE = 10_000;

interface OperatorProGrantResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * The narrow service-role capability this grant needs. It is deliberately not a
 * generic Supabase client: nothing here may read or write tenant domain rows.
 */
export interface OperatorProGrantClient {
  rpc(
    functionName: "grant_operator_ai_item_allowance",
    args: { p_user_id: string; p_allowance: number },
  ): PromiseLike<OperatorProGrantResult>;
}

export interface EnsureOperatorProAllowanceInput {
  /** The AUTHENTICATED Clerk subject. Never a client-supplied field. */
  userId: string;
  client: OperatorProGrantClient;
  env?: Record<string, string | undefined>;
}

/** True only for an exact match against the configured Clerk subjects. */
export function isOperatorProUser(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getProOperatorUserIds(env).includes(userId);
}

/**
 * Materializes the operator's allowance period, or does nothing at all.
 *
 * Returns whether a grant was issued. A failed grant throws rather than
 * resolving false, so a caller can never log "granted" for a period the
 * database refused to write.
 */
export async function ensureOperatorProAllowance(
  input: EnsureOperatorProAllowanceInput,
): Promise<boolean> {
  if (!isOperatorProUser(input.userId, input.env ?? process.env)) return false;

  const { error } = await input.client.rpc("grant_operator_ai_item_allowance", {
    p_user_id: input.userId,
    p_allowance: OPERATOR_PRO_ALLOWANCE,
  });
  if (error) throw new Error(error.message);
  return true;
}
