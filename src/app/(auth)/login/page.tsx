import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import FadeContent from "@/components/bits/FadeContent";
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
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 pt-2 pb-[20vh]">
      {/* react-bits FadeContent: one soft blur-up entrance for the whole card */}
      <FadeContent
        blur
        duration={600}
        className="flex w-full flex-col items-center gap-7"
      >
        <div className="text-center">
          {/* Landing-hero type treatment: display face, tight tracking, the
              em/italic iris accent. Copy sits on the prism band, so it stays
              full-ink (text-flash) like the hero's BlurText paragraph. */}
          <h1 className="font-display text-[clamp(30px,5vw,37px)] font-bold leading-tight tracking-tight text-flash">
            Welcome back to <em className="text-iris">SnapList</em>
          </h1>
          <p className="mx-auto mt-2.5 max-w-[40ch] text-[16.5px] font-semibold leading-relaxed text-flash">
            Snap a photo of something you want to sell. We identify it, price
            it with sources, and write the listing.
          </p>
        </div>
        <SignIn
          routing="hash"
          signUpUrl="/signup"
          fallbackRedirectUrl={safeNext(next)}
          signUpFallbackRedirectUrl={safeNext(next)}
        />
      </FadeContent>
    </main>
  );
}
