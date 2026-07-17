"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { reportServerError } from "@/lib/sentry";
import { setAutopilotEnabled } from "@/lib/settings/user-settings";
import { createClient } from "@/lib/supabase/server";
import { enqueueUpload } from "./durable-actions";

/**
 * Compatibility alias for older rendered action references.
 *
 * All live single-item work now enters the durable staging transaction, so an
 * old action id cannot bypass logical-run credit reservation with the retired
 * request-bound model pipeline.
 */
export async function uploadAndProcess(formData: FormData): Promise<void> {
  return enqueueUpload(formData);
}

/** Persist the settings-page publish-eligibility preference. */
export async function setAutopilotSetting(formData: FormData) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  const enabled = formData.get("enabled") === "true";
  try {
    await setAutopilotEnabled(supabase, userId, enabled);
  } catch (error) {
    reportServerError("settings.autopilot", error);
    redirect(
      `/settings?error=${encodeURIComponent("Couldn't update publish eligibility. Please try again.")}`,
    );
  }

  revalidatePath("/settings");
  redirect("/settings");
}
