import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Inbox loading state (audit I-2). */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <SkeletonCard />
      <SkeletonCard />
    </main>
  );
}
