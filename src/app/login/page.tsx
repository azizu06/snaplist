import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Banner } from "@/components/ui/banner";
import { signIn, signUp } from "./actions";
import { safeNext } from "./safe-next";
import { LoginForm } from "./login-form";

/**
 * Sign-in / sign-up (issue #40 skin: L-1…L-4). Segmented modes live in the
 * client form; the server actions are unchanged. If already signed in, bounce
 * to the validated `next`.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const { error, notice, next } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Validate `next` here too — this signed-in branch must not become an open redirect.
  if (user) redirect(safeNext(next));

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Welcome to SnapList
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Snap a photo of something you want to sell — we identify it, price it
          with sources, and write the listing.
        </p>
      </div>

      {error ? (
        <Banner variant="error" title="Couldn’t sign you in">
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner variant="success" title={notice} />
      ) : null}

      <LoginForm next={next} signIn={signIn} signUp={signUp} />
    </main>
  );
}
