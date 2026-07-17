import { notFound } from "next/navigation";
import { DurableProgressPreview } from "./durable-progress-preview";
import {
  durableProgressFixtures,
  isDurableProgressScenario,
} from "./fixtures";

// Every query-string scenario is a separate review fixture. Opt out of static
// rendering so repeated Playwright navigations cannot receive an earlier
// scenario from the development route cache.
export const dynamic = "force-dynamic";

export default async function DurableProgressPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const flow = params.flow === "batch" ? "batch" : "single";
  const theme = params.theme === "dark" ? "dark" : "light";
  const rawScenario = typeof params.scenario === "string" ? params.scenario : "slow";
  const scenario = isDurableProgressScenario(rawScenario) ? rawScenario : "slow";

  return (
    <DurableProgressPreview
      runs={durableProgressFixtures(flow, scenario)}
      flow={flow}
      theme={theme}
    />
  );
}
