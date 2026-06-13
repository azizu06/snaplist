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
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 pb-16 pt-2">
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
          <h1 className="font-display text-[clamp(28px,4.5vw,34px)] font-bold leading-tight tracking-tight text-flash">
            Welcome back to <em className="text-iris">SnapList</em>
          </h1>
          <p className="mx-auto mt-2.5 max-w-[40ch] text-[14px] font-medium leading-relaxed text-flash/85">
            Snap a photo of something you want to sell — we identify it, price
            it with sources, and write the listing.
          </p>
        </div>
        <SignIn
          routing="hash"
          fallbackRedirectUrl={safeNext(next)}
          signUpFallbackRedirectUrl={safeNext(next)}
        />
        {/* Trust strip — the landing hero's glass pill, condensed to the two
            points that matter at the door. */}
        <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 rounded-full border border-white/55 bg-white/70 px-4.5 py-1.5 text-[12px] font-semibold text-flash shadow-xs backdrop-blur dark:border-white/10 dark:bg-white/10">
          {["Free while in beta", "No credit card required"].map((point) => (
            <span key={point} className="flex items-center gap-1.5">
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="size-3 text-iris"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              {point}
            </span>
          ))}
        </p>
      </FadeContent>
    </main>
  );
}
