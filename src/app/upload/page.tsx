import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { setAutopilotSetting, uploadAndProcess } from "./actions";

/**
 * Upload page — pick one photo, submit, get a persisted review page. Skeleton-level
 * UI. Protected: middleware redirects anonymous users, and we re-check here.
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

  // Master autopilot switch (issue #12). Read per-user; missing row = enabled.
  const autopilotEnabled = await getAutopilotEnabled(supabase, user.id);

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New listing</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Upload a photo. We&apos;ll identify, price, and draft the listing.
          </p>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-xs text-zinc-400 underline hover:text-zinc-600"
          >
            Sign out
          </button>
        </form>
      </header>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <form action={uploadAndProcess} className="flex flex-col gap-4">
        <input
          type="file"
          name="photo"
          accept="image/png,image/jpeg,image/webp"
          required
          className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Process photo
        </button>
      </form>

      <section className="flex items-center justify-between rounded-md border border-zinc-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Autopilot</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {autopilotEnabled
              ? "On — high-confidence items are queued for auto-posting."
              : "Off — every item queues for your review before posting."}
          </p>
        </div>
        <form action={setAutopilotSetting}>
          <input
            type="hidden"
            name="enabled"
            value={autopilotEnabled ? "false" : "true"}
          />
          <button
            type="submit"
            className={
              autopilotEnabled
                ? "rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                : "rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300"
            }
          >
            {autopilotEnabled ? "Turn off" : "Turn on"}
          </button>
        </form>
      </section>

      <p className="text-xs text-zinc-400">
        Walking skeleton: identification, pricing, and listing copy are stubbed —
        the spine (auth → storage → pipeline → persisted review) is real.
      </p>
    </main>
  );
}
