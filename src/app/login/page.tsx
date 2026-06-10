import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signIn, signUp } from "./actions";

/**
 * Minimal sign-in / sign-up page. Skeleton-level UI (functional Tailwind, no design
 * pass). Two submit buttons share one form, posting to the `signIn` / `signUp`
 * server actions. If already signed in, bounce to /upload.
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
  if (user) redirect(next ?? "/upload");

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">SnapList</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sign in to turn a photo into a priced listing.
        </p>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      <form className="flex flex-col gap-3">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600">Password</span>
          <input
            type="password"
            name="password"
            required
            minLength={6}
            autoComplete="current-password"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <div className="mt-2 flex gap-3">
          <button
            type="submit"
            formAction={signIn}
            className="flex-1 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Sign in
          </button>
          <button
            type="submit"
            formAction={signUp}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-50"
          >
            Sign up
          </button>
        </div>
      </form>

      <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-600">
        ← Back
      </Link>
    </main>
  );
}
