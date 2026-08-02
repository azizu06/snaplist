"use server";

import { tierLimits } from "@/lib/abuse/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

const waitlistEmailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());

export type WaitlistFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "invalid" };

export async function submitWaitlistSignup(
  _previousState: WaitlistFormState,
  formData: FormData,
): Promise<WaitlistFormState> {
  if (String(formData.get("company") ?? "").trim()) {
    return { status: "success" };
  }

  const parsedEmail = waitlistEmailSchema.safeParse(formData.get("email"));
  if (!parsedEmail.success) return { status: "invalid" };

  const database = createAdminClient();
  const { error } = await database.rpc("insert_waitlist_signup", {
    p_email: parsedEmail.data,
    p_rate_limit: tierLimits("free").meteredPerMinute,
  });

  if (error) throw error;

  return { status: "success" };
}
