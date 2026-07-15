import type { ReactNode } from "react";

/**
 * The app shell deliberately owns the viewport height. The zero-question
 * state can be taller than that viewport, so this is the one place it may
 * scroll. Keeping the wrapper shared with the fixture preview makes the
 * mobile layout we review the same contract the signed-in inbox ships.
 */
export function InboxEmptyScrollArea({ children }: { children: ReactNode }) {
  return (
    <div
      data-inbox-empty-scroll-region
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <div
        data-inbox-empty-content
        className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6"
      >
        {children}
      </div>
    </div>
  );
}
