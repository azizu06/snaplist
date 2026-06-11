import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Publish-page loading state (audit P-1 adjacent). */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <Skeleton className="h-7 w-52" />
      <SkeletonCard />
      <SkeletonCard />
    </main>
  );
}
