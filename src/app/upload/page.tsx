import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { uploadAndProcess } from "./actions";
import { UploadView } from "./upload-form";

/**
 * Upload — the core moment (audit U-1/U-2/U-3). Data assembly only; the
 * Mercari-style sell sheet lives in UploadView (issue #40 round 2). The
 * server action is unchanged (AC5); the autopilot switch lives in /settings.
 */
export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/upload");

  return <UploadView action={uploadAndProcess} actionError={error ?? null} />;
}
