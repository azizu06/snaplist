import { NextResponse } from "next/server";
import { resolveScoutGuidance } from "@/lib/scout-guidance";

const scoutGuidanceProbe = resolveScoutGuidance({
  contractVersion: "scout-guidance-v1",
  state: "onboarding.outcome",
  locale: "en-US",
  substitutions: {},
});

/** Liveness probe — confirms the app boots with its provider-neutral contracts. */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "snaplist",
    contracts: {
      scoutGuidance: {
        version: scoutGuidanceProbe.contractVersion,
        state: scoutGuidanceProbe.state,
        title: scoutGuidanceProbe.message.title,
      },
    },
  });
}
