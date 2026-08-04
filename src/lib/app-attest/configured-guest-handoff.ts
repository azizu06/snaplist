import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createAppleAppAttestVerifier } from "./apple-verifier";
import { createAppAttestService, type AppAttestEnvironment } from "./service";
import { createSupabaseAppAttestStore } from "./supabase-store";
import {
  createGuestAttestationHandler,
  createGuestClaimHandoffService,
} from "./guest-handoff";
import { createSupabaseGuestClaimHandoffStore } from "./guest-handoff-supabase-store";

type GuestClaimHandoffEnv = Readonly<Record<string, string | undefined>>;

type GuestClaimHandoffEnvName =
  | "APP_ATTEST_BUNDLE_ID"
  | "APP_ATTEST_CHALLENGE_TTL_SECONDS"
  | "APP_ATTEST_ENVIRONMENT"
  | "APP_ATTEST_HANDOFF_SIGNING_KEY"
  | "APP_ATTEST_HANDOFF_TTL_SECONDS"
  | "APP_ATTEST_ROOT_CA_PEM"
  | "APP_ATTEST_TEAM_ID";

function required(env: GuestClaimHandoffEnv, name: GuestClaimHandoffEnvName): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Guest claim handoff ${name} is not configured.`);
  return value;
}

function ttlMs(value: string, name: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 600) {
    throw new Error(`Guest claim handoff ${name} is invalid.`);
  }
  return seconds * 1_000;
}

export function resolveGuestClaimHandoffConfiguration(
  env: GuestClaimHandoffEnv = process.env,
) {
  const teamId = required(env, "APP_ATTEST_TEAM_ID");
  const bundleId = required(env, "APP_ATTEST_BUNDLE_ID");
  const environment = required(env, "APP_ATTEST_ENVIRONMENT");
  const appleRootCertificatePem = required(env, "APP_ATTEST_ROOT_CA_PEM")
    .replaceAll("\\n", "\n");
  const encodedSigningKey = required(env, "APP_ATTEST_HANDOFF_SIGNING_KEY");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("Guest claim handoff APP_ATTEST_TEAM_ID is invalid.");
  }
  if (
    bundleId.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)
  ) {
    throw new Error("Guest claim handoff APP_ATTEST_BUNDLE_ID is invalid.");
  }
  if (environment !== "development" && environment !== "production") {
    throw new Error("Guest claim handoff APP_ATTEST_ENVIRONMENT is invalid.");
  }
  if (
    !appleRootCertificatePem.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !appleRootCertificatePem.endsWith("\n-----END CERTIFICATE-----")
  ) {
    throw new Error("Guest claim handoff APP_ATTEST_ROOT_CA_PEM is invalid.");
  }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(encodedSigningKey) ||
    Buffer.from(encodedSigningKey, "base64url").byteLength !== 32
  ) {
    throw new Error("Guest claim handoff APP_ATTEST_HANDOFF_SIGNING_KEY is invalid.");
  }

  return {
    appId: `${teamId}.${bundleId}`,
    appleRootCertificatePem,
    challengeTtlMs: ttlMs(
      env.APP_ATTEST_CHALLENGE_TTL_SECONDS ?? "300",
      "APP_ATTEST_CHALLENGE_TTL_SECONDS",
    ),
    environment: environment as AppAttestEnvironment,
    handoffSigningKey: Buffer.from(encodedSigningKey, "base64url"),
    handoffTtlMs: ttlMs(
      env.APP_ATTEST_HANDOFF_TTL_SECONDS ?? "300",
      "APP_ATTEST_HANDOFF_TTL_SECONDS",
    ),
  };
}

export function createConfiguredGuestClaimHandoff(
  env: GuestClaimHandoffEnv = process.env,
) {
  const config = resolveGuestClaimHandoffConfiguration(env);
  const admin = createAdminClient();
  const appAttest = createAppAttestService({
    appId: config.appId,
    challengeTtlMs: config.challengeTtlMs,
    environment: config.environment,
    store: createSupabaseAppAttestStore(admin),
    verifier: createAppleAppAttestVerifier({
      appleRootCertificatePem: config.appleRootCertificatePem,
    }),
  });
  const handoffs = createGuestClaimHandoffService({
    appId: config.appId,
    environment: config.environment,
    signingKey: config.handoffSigningKey,
    store: createSupabaseGuestClaimHandoffStore(admin),
    ttlMs: config.handoffTtlMs,
  });

  return {
    handleAttestation: createGuestAttestationHandler({ appAttest, handoffs }),
    verifyGuestClaimHandoff: handoffs.verify,
  };
}
