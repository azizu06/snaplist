"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSupabaseClient } from "@/lib/supabase/client";
import type { NotificationKind, NotificationView } from "@/lib/notifications";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/(app)/notifications/actions";

/**
 * Top-bar notification bell. Server hands the recent rows + the signed-in
 * user id; the bell then rides Supabase Realtime for new ones (no refresh),
 * the same pattern as the live inbox (#13). Standard dropdown behavior
 * (click-outside + Escape). Marking read is optimistic — the row dims
 * immediately and the server write rides a transition. In dev preview /
 * signed-out there is no userId, so it renders the seeded rows without a
 * live subscription.
 */

const KINDS = [
  "listing_published",
  "listing_failed",
  "buyer_message",
  "system",
] as const;

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Stable UTC label — avoids the hydration mismatch a locale/relative time causes. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function rowToView(raw: unknown): NotificationView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.kind !== "string" ||
    typeof r.title !== "string" ||
    typeof r.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: r.id,
    kind: (KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as NotificationKind)
      : "system",
    title: r.title,
    body: typeof r.body === "string" ? r.body : null,
    href: typeof r.href === "string" ? r.href : null,
    read: r.read_at != null,
    createdAt: r.created_at,
  };
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  const cls = "size-4";
  if (kind === "listing_published") {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-soft-fg">
        <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (kind === "listing_failed") {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger-soft text-danger-soft-fg">
        <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
      </span>
    );
  }
  if (kind === "buyer_message") {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-fg">
        <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    </span>
  );
}

export function NotificationBell({
  userId,
  initial,
}: {
  userId: string | null;
  initial: NotificationView[];
}) {
  const router = useRouter();
  const supabase = useSupabaseClient();
  const [items, setItems] = useState<NotificationView[]>(initial);
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  const unread = items.reduce((n, it) => (it.read ? n : n + 1), 0);

  // Live updates — INSERT prepends, UPDATE reconciles read-state. RLS authorizes
  // each event against the subscriber's JWT, so only the user's own rows arrive.
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel("topbar-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = rowToView(payload.new);
          if (!row) return;
          setItems((prev) =>
            prev.some((p) => p.id === row.id) ? prev : [row, ...prev].slice(0, 30),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = rowToView(payload.new);
          if (!row) return;
          setItems((prev) => prev.map((p) => (p.id === row.id ? row : p)));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

  // Click-outside + Escape close (same behavior as ProfileMenu).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const markOneRead = (id: string) => {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, read: true } : p)));
    startTransition(() => {
      void markNotificationRead(id);
    });
  };

  const onItemClick = (n: NotificationView) => {
    if (!n.read) markOneRead(n.id);
    setOpen(false);
    if (n.href) router.push(n.href);
  };

  const markAllRead = () => {
    if (unread === 0) return;
    setItems((prev) => prev.map((p) => ({ ...p, read: true })));
    startTransition(() => {
      void markAllNotificationsRead();
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
        className={`relative flex size-9 items-center justify-center rounded-lg transition-colors motion-safe:active:scale-[0.96] ${
          open ? "bg-surface-2 text-fg-strong" : "text-muted hover:bg-surface-2 hover:text-fg-strong"
        }`}
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10.27 21a2 2 0 0 0 3.46 0" />
          <path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.4 13.92 18 12.5 18 8a6 6 0 1 0-12 0c0 4.5-1.4 5.92-2.74 7.33Z" />
        </svg>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-accent-solid px-1 text-[10.5px] font-bold leading-[16px] text-accent-fg ring-2 ring-surface">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Notifications"
          className="menu-pop absolute right-0 top-full z-40 mt-4 w-[22rem] max-w-[calc(100vw-1.5rem)] origin-top-right overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <p className="text-[14px] font-semibold text-fg-strong">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                className="rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-accent-soft-fg transition-colors hover:bg-accent-soft"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-muted">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10.27 21a2 2 0 0 0 3.46 0" />
                  <path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.4 13.92 18 12.5 18 8a6 6 0 1 0-12 0c0 4.5-1.4 5.92-2.74 7.33Z" />
                </svg>
              </span>
              <p className="text-[14px] font-medium text-fg">You&rsquo;re all caught up</p>
              <p className="text-[13px] text-muted">
                Listing updates and buyer questions show up here.
              </p>
            </div>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onItemClick(n)}
                    className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 ${
                      n.read ? "" : "bg-accent-soft/40"
                    }`}
                  >
                    <KindIcon kind={n.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`min-w-0 flex-1 truncate text-[14px] ${n.read ? "font-medium text-fg" : "font-semibold text-fg-strong"}`}>
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[12px] text-muted" data-nums>
                          {formatTime(n.createdAt)}
                        </span>
                      </span>
                      {n.body ? (
                        <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted">
                          {n.body}
                        </span>
                      ) : null}
                    </span>
                    {n.read ? null : (
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-solid" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
