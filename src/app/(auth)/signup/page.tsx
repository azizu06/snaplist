import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import FadeContent from "@/components/bits/FadeContent";
import { getUserId } from "@/lib/auth";
import { safeNext } from "../login/safe-next";

/**
 * Sign-up — the "Start selling" entry point. The nav now routes returning
 * sellers to /login (<SignIn>) and new sellers here (<SignUp>) so the two CTAs
 * land on the mode the user actually wants, instead of both opening sign-in and
 * making new sellers hunt for the sign-up link. Same (auth) chrome (prism slab
 * + aurora) and the same hash routing — Clerk handles verification/OAuth.
 *
 * `signInUrl="/login"` keeps Clerk's "Already have an account?" link on our own
 * route, not Clerk's hosted page. `next` is validated through safeNext on both
 * the already-signed-in bounce and Clerk's post-auth redirect (no open redirect).
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  const userId = await getUserId();
  if (userId) redirect(safeNext(next));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 pt-2 pb-[10vh]">
      <FadeContent
        blur
        duration={600}
        className="flex w-full flex-col items-center gap-7"
      >
        <div className="text-center">
          <h1 className="font-display text-[clamp(30px,5vw,37px)] font-bold leading-tight tracking-tight text-flash">
            Start selling on <em className="text-iris">SnapList</em>
          </h1>
          <p className="mx-auto mt-2.5 max-w-[40ch] text-[16.5px] font-semibold leading-relaxed text-flash">
            Snap a photo of something you want to sell. We identify it, price it
            with sources, and write the listing.
          </p>
        </div>
        <SignUp
          routing="hash"
          signInUrl="/login"
          fallbackRedirectUrl={safeNext(next)}
          signInFallbackRedirectUrl={safeNext(next)}
        />
      </FadeContent>
    </main>
  );
}
