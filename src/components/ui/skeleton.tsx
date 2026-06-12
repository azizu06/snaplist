/** Skeleton primitives (audit X-3) for route-level loading.tsx files. */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`skeleton-shimmer animate-pulse rounded-md bg-surface-3 ${className}`}
    />
  );
}

/** A generic card-shaped loading block: title line + two content lines. */
export function SkeletonCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
