import { Skeleton } from "@/components/ui/skeleton";

/**
 * Export loading state (audit E-4; redesign/export) — pack generation can take a
 * moment. The skeleton mirrors the real layout: the back arrow + title row, the
 * intro line, an item strip, then two pack cards (titled header + preview block)
 * so the page doesn't reflow when the packs land.
 */
function PackSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="hidden h-9 w-20 rounded-md sm:block" />
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,210px)] sm:p-5">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-2/60 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-lg sm:size-9" />
        <Skeleton className="h-7 w-56" />
      </div>
      <Skeleton className="h-4 w-full max-w-lg" />
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
        <Skeleton className="size-14 shrink-0 rounded-xl" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-44" />
        </div>
      </div>
      <PackSkeleton />
      <PackSkeleton />
    </main>
  );
}
