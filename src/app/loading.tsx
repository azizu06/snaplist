import { Skeleton } from "@/components/ui/skeleton";

/**
 * Root Suspense fallback — the only `loading.tsx` in `src/app`, so it covers
 * every route under this layout without its own: `(auth)/login`,
 * `(auth)/signup`, and every `(marketing)` page. Kept narrow and generic
 * (no list/card shape) since the `(app)` dashboard route group it used to
 * back was retired (#598) and none of the surviving routes show a list.
 */
export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 pt-2 pb-[20vh]">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-64" />
    </main>
  );
}
