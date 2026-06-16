import { Skeleton } from "@/components/ui/skeleton";

/** Inbox loading state — mirrors the two-pane messaging shell (audit I-2). */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="flex min-h-[60vh] overflow-hidden rounded-xl border border-border bg-surface shadow-xs lg:min-h-[34rem]">
        {/* left: conversation list */}
        <div className="hidden w-[340px] shrink-0 flex-col border-r border-border lg:flex">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-20" />
          </div>
          <div className="flex flex-col gap-4 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* right: thread */}
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-3">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-4 p-6">
            <Skeleton className="h-16 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-20 w-3/5 rounded-2xl" />
          </div>
          <div className="border-t border-border p-5">
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </main>
  );
}
