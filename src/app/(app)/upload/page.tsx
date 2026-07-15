import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const userId = await getUserId();
  if (!userId) redirect("/login?next=/upload");

  return (
    <UploadView
      action={enqueueUpload}
      actionError={error ?? null}
      captureId={crypto.randomUUID()}
    />
  );
}
