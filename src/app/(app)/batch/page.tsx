import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { BatchCaptureView } from "./batch-capture";

/**
 * /batch — bulk / haul capture (issue #100): photograph N items in one
 * session → batch pipeline → triage list. The auth proxy gates the route;
 * the redirect below is defense-in-depth (same idiom as /upload and
 * /dashboard). All the flow state is client-side (photo Files can't be
 * serialized), so this page only authenticates and mounts the view.
 */
export default async function BatchPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/batch");
  return <BatchCaptureView />;
}
