import { notFound } from "next/navigation";
import { DurableProgressPreview } from "../../../durable-progress-preview";
import {
  durableProgressFixtures,
  isDurableProgressScenario,
  type DurableProgressFlow,
  type DurableProgressTheme,
} from "../../../fixtures";

export const dynamic = "force-dynamic";

export default async function DurableProgressPathPreviewPage({
  params,
}: {
  params: Promise<{ flow: string; scenario: string; theme: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { flow: rawFlow, scenario: rawScenario, theme: rawTheme } = await params;
  if (
    (rawFlow !== "single" && rawFlow !== "batch") ||
    !isDurableProgressScenario(rawScenario) ||
    (rawTheme !== "light" && rawTheme !== "dark")
  ) {
    notFound();
  }

  const flow: DurableProgressFlow = rawFlow;
  const theme: DurableProgressTheme = rawTheme;
  return (
    <DurableProgressPreview
      runs={durableProgressFixtures(flow, rawScenario)}
      flow={flow}
      theme={theme}
    />
  );
}
