import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/**
 * Review loading state — mirrors the Shopify product-edit two-column shape
 * (left main column: media + listing copy; right sidebar: identification,
 * price, item details), so the skeleton holds the real layout instead of a
 * generic block.
 */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      {/* top bar */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="ml-auto hidden h-8 w-36 rounded-lg sm:block" />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="flex flex-col gap-5">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </main>
  );
}
