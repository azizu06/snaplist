import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * Landing page (public). Minimal skeleton entry: routes the visitor to the upload
 * flow if signed in, otherwise to sign-in. Visual polish is a later, separate task.
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">SnapList</h1>
      <p className="text-zinc-600">
        Turn a photo of a used item into a priced, ready-to-post listing.
      </p>
      <div className="flex gap-3">
        {user ? (
          <Link
            href="/upload"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Start a listing
          </Link>
        ) : (
          <Link
            href="/login"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Sign in
          </Link>
        )}
      </div>
    </main>
  );
}
