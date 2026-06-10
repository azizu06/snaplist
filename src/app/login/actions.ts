"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "./safe-next";

/**
 * Minimal email/password auth server actions (User Story 33: "sign up and sign
 * in"). Just enough to obtain a session so the rest of the walking skeleton runs
 * behind Auth + RLS. Full account UX (email verification flows, password reset,
 * OAuth) is out of scope for the skeleton.
 *
 * On success we redirect to `next` (defaulting to /upload). On failure we redirect
 * back to /login?error=... so the page can render the message without client JS.
 * Same-origin `next` validation lives in ./safe-next (shared with the page).
 */

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect(next);
}

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // With email confirmation enabled, there is no session yet — tell the user to
  // confirm. When confirmation is disabled (local dev default), a session exists
  // and we can go straight to the app.
  if (data.session) {
    redirect(next);
  }
  redirect(`/login?notice=${encodeURIComponent("Check your email to confirm your account, then sign in.")}`);
}
