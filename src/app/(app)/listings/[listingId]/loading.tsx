import { Skeleton } from "@/components/ui/skeleton";

/**
 * Publish-page loading state — mirrors the two-column record layout (preview on
 * the left, publishing rail on the right) so the skeleton matches the shape the
 * content settles into rather than flashing a generic block.
 */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      {/* top bar: back chip + title */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-7 w-48" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* preview card: photo + copy */}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>

        {/* publishing rail */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-xs">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-2 h-9 w-full rounded-lg" />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-xs">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      </div>
    </main>
  );
}
