"use server";

import { headers } from "next/headers";
import { createInMemoryLimiter } from "@/lib/abuse/store";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

const waitlistLimiter = createInMemoryLimiter(5, 10 * 60 * 1000);

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

  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for");
  const identifier = forwardedFor?.split(",")[0]?.trim()
    || requestHeaders.get("x-real-ip")
    || "unknown";
  const rateLimit = await waitlistLimiter.limit(identifier);
  if (!rateLimit.success) return { status: "success" };

  const parsedEmail = waitlistEmailSchema.safeParse(formData.get("email"));
  if (!parsedEmail.success) return { status: "invalid" };

  const email = parsedEmail.data;
  const database = createAdminClient();

  const { error } = await database
    .from("waitlist_signups")
    .insert({ email });

  if (error && error.code !== "23505") throw error;

  return { status: "success" };
}
