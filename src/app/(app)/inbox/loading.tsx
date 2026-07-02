import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inbox loading state — mirrors the REAL full-bleed two-pane messaging shell
 * (audit I-2): same viewport-height accounting as page.tsx (7rem of chrome +
 * safe-area below `sm`, the 72px top bar from `sm` up), the 72px list/thread
 * headers, round buyer avatars, and the mobile single-pane behavior (list
 * first; the thread pane only exists at `lg`). The old skeleton drew a
 * title-strip + bordered card that the shipped inbox no longer has, so the
 * swap from skeleton to content used to reflow the whole surface.
 */
export default function Loading() {
  return (
    <main className="flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] w-full flex-col overflow-hidden sm:h-[calc(100dvh-72px)]">
      <div className="flex min-h-0 flex-1 overflow-hidden bg-surface">
        {/* ── left: conversation list — full width on mobile (single pane),
            fixed default width at lg (the resizable pane's DEFAULT) ── */}
        <div className="flex min-h-0 w-full flex-col lg:w-[340px] lg:shrink-0">
          <div className="flex h-[72px] shrink-0 items-center justify-between gap-2 bg-surface-2 px-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
          <div className="flex flex-col">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-4">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-10" />
                  </div>
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* divider — where the resize handle's hairline sits */}
        <div aria-hidden className="hidden w-px shrink-0 bg-border lg:block" />

        {/* ── right: thread pane — desktop only (mobile is list-first) ── */}
        <div className="hidden min-h-0 flex-1 flex-col lg:flex">
          <div className="flex h-[72px] shrink-0 items-center gap-3 bg-surface-2 px-4">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex flex-1 flex-col gap-3 px-5 py-5">
            <Skeleton className="h-14 w-2/5 rounded-2xl" />
            <Skeleton className="ml-auto h-16 w-1/3 rounded-2xl" />
          </div>
          <div className="bg-surface-2 px-5 py-4">
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </main>
  );
}
