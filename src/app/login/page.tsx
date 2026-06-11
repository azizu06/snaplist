import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { getUserId } from "@/lib/auth";
import { safeNext } from "./safe-next";

/**
 * Sign-in / sign-up — Clerk era (issue #41). Clerk's prebuilt <SignIn />
 * handles both modes (it links to sign-up), email verification, password
 * reset, and OAuth — all the account UX the hand-rolled form deliberately
 * skipped. Hash routing keeps everything on this one route.
 *
 * `next` is still validated through safeNext on BOTH paths (the already-
 * signed-in bounce and Clerk's post-auth redirect) so it can't become an open
 * redirect.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  const userId = await getUserId();
  if (userId) redirect(safeNext(next));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-6 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Welcome to SnapList
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Snap a photo of something you want to sell — we identify it, price it
          with sources, and write the listing.
        </p>
      </div>
      <SignIn
        routing="hash"
        fallbackRedirectUrl={safeNext(next)}
        signUpFallbackRedirectUrl={safeNext(next)}
      />
    </main>
  );
}
