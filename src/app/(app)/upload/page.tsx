import { redirect } from "next/navigation";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { buildPipelineRecoveryHref } from "@/lib/pipeline-progress";
import { createClient } from "@/lib/supabase/server";
import { enqueueUpload } from "./durable-actions";
import { UploadView } from "./upload-form";

/**
 * Upload — the core moment (audit U-1/U-2/U-3). Data assembly only; the
 * Mercari-style sell sheet lives in UploadView (issue #40 round 2). The
 * server action is unchanged (AC5); the publish-eligibility switch lives in /settings.
 */
export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; batch?: string }>;
}) {
  const { error, batch } = await searchParams;
  const parsedBatchId = z.string().uuid().safeParse(batch);
  const recoveryHref = parsedBatchId.success
    ? buildPipelineRecoveryHref("/upload", parsedBatchId.data)
    : "/upload";

  const userId = await getUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent(recoveryHref)}`);

  if (parsedBatchId.success) {
    const supabase = await createClient();
    const { data, error: recoveryError } = await supabase
      .from("pipeline_runs")
      .select("item_id")
      .eq("batch_id", parsedBatchId.data)
      .order("batch_position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (recoveryError) {
      throw new Error(`Failed to load upload progress: ${recoveryError.message}`);
    }
    if (data) redirect(`/review/${data.item_id}?new=1`);
  }

  return (
    <UploadView
      action={enqueueUpload}
      actionError={error ?? null}
      recoveryBatchId={parsedBatchId.success ? parsedBatchId.data : undefined}
    />
  );
}
