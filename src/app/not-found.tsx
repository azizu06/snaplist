import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * Branded 404 (redesign: neutral + green). The app had no custom not-found
 * before — an unmatched route fell through to Next's bare default. This is the
 * designed dead-end recovery the strategic-omissions audit calls for: a calm,
 * on-palette page that names what happened plainly (no "Oops!"), shows the
 * brand, and always offers a way back. Server component; uses the root layout's
 * fonts + theme tokens, so it themes light/dark for free.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-1 flex-col items-center justify-center gap-7 px-6 py-16 text-center">
      <Link href="/" aria-label="SnapList home" className="inline-flex">
        <Logo markClassName="size-9" />
      </Link>

      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-faint"
          data-nums
        >
          <span className="h-[2px] w-6 rounded-full bg-accent" />
          Error 404
        </span>
        <h1 className="font-display text-[clamp(26px,6vw,34px)] font-bold leading-tight tracking-tight text-fg-strong text-balance">
          We couldn&apos;t find that page
        </h1>
        <p className="max-w-[42ch] text-[15px] leading-relaxed text-muted text-pretty">
          The link may be broken or the listing may have moved. Your items and
          listings are safe in your shop.
        </p>
      </div>

      <div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover motion-safe:active:scale-[0.98]"
        >
          Go to your listings
        </Link>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
