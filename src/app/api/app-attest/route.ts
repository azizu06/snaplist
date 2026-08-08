import { NextResponse } from "next/server";
import { enforceAppAttestRateLimit } from "@/lib/abuse";
import { createAppleAppAttestVerifier } from "@/lib/app-attest/apple-verifier";
import { createAppAttestHttpHandler } from "@/lib/app-attest/http";
import { createAppAttestService, type AppAttestEnvironment } from "@/lib/app-attest/service";
import { createSupabaseAppAttestStore } from "@/lib/app-attest/supabase-store";
import { createVerifiedGuestCapabilityService } from "@/lib/guest-capability/service";
import { createSupabaseVerifiedGuestCapabilityStore } from "@/lib/guest-capability/supabase-store";
import { logServerError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function unavailable(): NextResponse {
  return NextResponse.json(
    { data: { code: "service_unavailable", status: "unavailable" } },
    { status: 503 },
  );
}

function configuration(): {
  appId: string;
  environment: AppAttestEnvironment;
  ttlMs: number;
} | null {
  const appId = process.env.APP_ATTEST_APP_ID;
  const environment = process.env.APP_ATTEST_ENVIRONMENT;
  const ttlSeconds = Number(process.env.APP_ATTEST_CHALLENGE_TTL_SECONDS ?? "300");
  if (
    !appId ||
    !/^[A-Z0-9]{10}\.dev\.snaplist\.ios$/.test(appId) ||
    (environment !== "development" && environment !== "production") ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 600
  ) {
    return null;
  }
  return { appId, environment, ttlMs: ttlSeconds * 1000 };
}

export async function POST(request: Request): Promise<Response> {
  const limited = await enforceAppAttestRateLimit(request);
  if (limited) return limited;

  const config = configuration();
  if (!config) return unavailable();
  const configured = config;

  let dependencies:
    | {
        appAttest: ReturnType<typeof createAppAttestService>;
        guestCapability: ReturnType<typeof createVerifiedGuestCapabilityService>;
      }
    | undefined;
  function configuredDependencies() {
    if (dependencies) return dependencies;
    const client = createAdminClient();
    dependencies = {
      appAttest: createAppAttestService({
        appId: configured.appId,
        challengeTtlMs: configured.ttlMs,
        environment: configured.environment,
        reportVerificationError: (phase, error) =>
          logServerError(`app-attest.verify-${phase}`, error),
        store: createSupabaseAppAttestStore(client),
        verifier: createAppleAppAttestVerifier({}),
      }),
      guestCapability: createVerifiedGuestCapabilityService({
        store: createSupabaseVerifiedGuestCapabilityStore(client),
      }),
    };
    return dependencies;
  }

  return createAppAttestHttpHandler(
    () => configuredDependencies().appAttest,
    {
      issueGuestCapability: (assertion) =>
        configuredDependencies().guestCapability.issue(assertion),
    },
  )(request);
}
