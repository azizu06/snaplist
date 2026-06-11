import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Dashboard loading state (audit H-3). */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <SkeletonCard />
      <SkeletonCard />
    </main>
  );
}
