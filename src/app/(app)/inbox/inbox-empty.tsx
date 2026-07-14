import { InboxDemoVideo } from "./inbox-demo-video";

/**
 * Inbox empty state. A ghost-conversation composition — two tilted blank
 * message cards behind a low-opacity mock thread (buyer bubble + sparkle-drafted
 * reply) under a soft brand-green glow — reading as "this is what it will look
 * like", then one headline, one sentence, a hint about where messages come
 * from, and a lazy "watch how replies work" video teaser (a real inbox capture
 * remains visible until the mp4 can play, so it never reads broken).
 *
 * The empty-state illustration stays CSS/SVG; only the video teaser is a client
 * component — the state renders identically from the live inbox and the dev
 * preview harness.
 */

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.3 0 .57.2.66.49l1.4 4.6a3 3 0 0 0 1.99 1.99l4.6 1.4a.69.69 0 0 1 0 1.32l-4.6 1.4a3 3 0 0 0-1.99 1.99l-1.4 4.6a.69.69 0 0 1-1.32 0l-1.4-4.6a3 3 0 0 0-1.99-1.99l-4.6-1.4a.69.69 0 0 1 0-1.32l4.6-1.4a3 3 0 0 0 1.99-1.99l1.4-4.6c.09-.29.36-.49.66-.49Z" />
    </svg>
  );
}

/** Blank ghost card — a conversation that hasn't happened yet. */
function GhostCard({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`absolute inset-x-6 rounded-2xl border border-border bg-surface p-4 shadow-xs ${className}`}
    >
      <div className="max-w-[70%] rounded-xl rounded-bl-sm bg-surface-2 p-2.5">
        <span className="block h-1.5 w-24 rounded-full bg-border" />
        <span className="mt-1.5 block h-1.5 w-16 rounded-full bg-border/70" />
      </div>
      <div className="ml-auto mt-2.5 max-w-[60%] rounded-xl rounded-br-sm bg-brand-soft p-2.5">
        <span className="block h-1.5 w-20 rounded-full bg-brand-muted/40" />
      </div>
    </div>
  );
}

export function InboxEmptyState() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface pt-10 text-center shadow-xs">
      {/* soft brand-green bloom behind the composition (kept low — restraint) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(0, 128, 96, 0.08), rgba(0, 128, 96, 0.03) 55%, transparent)",
        }}
      />

      <div className="px-6">
        {/* ---- stacked ghost conversation ---- */}
        {/* The fade needs CONTENT to dissolve: a gradient over empty surface
            is invisible (card bg = container bg = surface), which is why no
            fade showed. So the thread ends with a faint trailing buyer
            message that the bottom gradient melts away — the approved reply
            ("...cables included.") stays fully crisp ABOVE the fade, and the
            dissolving stub reads as "more questions keep arriving." */}
        <div aria-hidden className="relative mx-auto h-72 w-full max-w-md select-none">
          <GhostCard className="top-3 -rotate-3 opacity-40" />
          <GhostCard className="top-1.5 rotate-2 opacity-60" />

          {/* the front card: a believable thread. Full opacity + one-tier
              brighter labels — the dimmed preview was unreadable (owner). */}
          <div className="absolute inset-x-0 top-0 rounded-2xl border border-accent/15 bg-surface p-4 text-left shadow-md">
            <div className="max-w-[78%] rounded-2xl rounded-bl-md border border-border bg-surface-2 px-3.5 py-2.5">
              <p className="text-[12.5px] font-semibold text-muted">buyer · via eBay</p>
              <p className="mt-0.5 text-[15px] leading-snug text-fg-strong">
                Hi! Does it come with the original box and cables?
              </p>
            </div>
            <div className="ml-auto mt-2.5 max-w-[80%] rounded-2xl rounded-br-md border border-brand-tint bg-brand-soft px-3.5 py-2.5">
              <p className="flex items-center gap-1 text-[12.5px] font-semibold text-accent-soft-fg">
                <SparkleIcon className="size-3" />
                Drafted from your listing
              </p>
              <p className="mt-0.5 text-[15px] leading-snug text-fg-strong">
                Yes, it ships in the original box with both cables included.
              </p>
            </div>
            {/* trailing stub — the gradient below dissolves this, giving the
                fade something visible to act on while the reply stays crisp */}
            <div className="mt-2.5 max-w-[72%] rounded-2xl rounded-bl-md border border-border bg-surface-2 px-3.5 py-2.5">
              <p className="text-[12.5px] font-semibold text-muted">buyer · via eBay</p>
              <p className="mt-0.5 text-[15px] leading-snug text-fg-strong">
                Perfect, would you take $90 shipped?
              </p>
            </div>
          </div>

          {/* dissolves the trailing stub into the copy below. Reaches up far
              enough (h-28) to melt the stub bubble, but its opaque region
              stays under the approved reply so "cables included" is crisp. */}
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-surface via-surface/90 to-transparent" />
        </div>

        {/* ---- copy: one headline, one sentence, one hint ---- */}
        <h3 className="mt-10 font-display text-[22px] font-bold tracking-tight text-fg-strong">
          No buyer questions yet
        </h3>
        <p className="mx-auto mt-2 max-w-lg text-[16.5px] leading-relaxed text-fg">
          When a buyer asks about one of your listings, it lands here live, with
          a reply already drafted for your approval.
        </p>
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/70 px-3.5 py-1.5 text-[14px] font-medium text-fg">
          <svg viewBox="0 0 24 24" className="size-3.5 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 1 1-9-9" />
            <path d="M21 3v6h-6" />
          </svg>
          eBay buyer questions sync here automatically, or try the simulator above.
        </p>
      </div>

      {/* ---- the flow, live: lazy muted-loop walkthrough. Sits outside the
           px-6 column so the 1920×1080 video gets the full panel width and
           the on-screen conversation stays legible (round-5 owner fix). ---- */}
      <InboxDemoVideo />
    </div>
  );
}
