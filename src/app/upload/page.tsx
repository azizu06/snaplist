import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Banner } from "@/components/ui/banner";
import { uploadAndProcess } from "./actions";
import { UploadForm } from "./upload-form";

/**
 * Upload — the core moment (audit U-1/U-2/U-3, Mercari-style capture).
 * Photo slots + the "what happens next" promise; the client form swaps to the
 * PROCESSING view while the (unchanged) server action runs. The autopilot
 * switch moved to /settings (X-11).
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

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          New listing
        </h1>
        <p className="mt-1 text-sm text-muted">
          Add photos of your item — we&apos;ll do the rest:
        </p>
        <ol className="mt-3 flex flex-col gap-1.5 text-sm text-muted">
          <li className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-soft-fg">
              1
            </span>
            Identify it — brand, model, condition
          </li>
          <li className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-soft-fg">
              2
            </span>
            Research a fair used price, with sources
          </li>
          <li className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-soft-fg">
              3
            </span>
            Draft the listing for your review
          </li>
        </ol>
      </header>

      {error ? (
        <Banner variant="error" title="That didn’t work">
          {error}
        </Banner>
      ) : null}

      <UploadForm action={uploadAndProcess} />
    </main>
  );
}
