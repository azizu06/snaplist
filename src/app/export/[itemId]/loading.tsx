import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Export loading state (audit E-4) — pack generation can take a moment. */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-full max-w-md" />
      <SkeletonCard />
      <SkeletonCard />
    </main>
  );
}
