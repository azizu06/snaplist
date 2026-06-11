import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Review loading state (audit X-3). */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <Skeleton className="h-7 w-56" />
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-5">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard />
      </div>
    </main>
  );
}
