/** Skeleton primitive (audit X-3) for route-level loading.tsx files. */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`skeleton-shimmer animate-pulse rounded-md bg-surface-3 ${className}`}
    />
  );
}
