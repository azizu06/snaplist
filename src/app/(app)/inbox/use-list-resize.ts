"use client";

import { useRef, useState, useSyncExternalStore } from "react";

/**
 * Resizable conversation-list width, shared by the live inbox and its dev
 * preview so both behave identically. The width persists in localStorage and is
 * read through useSyncExternalStore so SSR + the first client paint agree on the
 * default (avoiding a hydration mismatch) and the saved value applies cleanly
 * after hydration — the same pattern the inbox already uses for `useHydrated`.
 *
 * The drag follows the pointer via pointer capture, so it survives the cursor
 * leaving the thin hit area; consumers toggle the width transition off while
 * `dragging` so it tracks 1:1, then eases on any non-drag change.
 */

const COLLAPSED_W = 72; // avatar-only rail
const MIN = 248; // smallest EXPANDED width
const MAX = 560;
const DEFAULT = 340;
const COLLAPSE_AT = 200; // drag narrower than this → snap to the collapsed rail
const KEY = "snaplist.inbox-list-w";

const clampExpanded = (n: number) => Math.min(MAX, Math.max(MIN, n));
/** Snap a raw dragged width to either the collapsed rail or a clamped
 *  expanded width — dragging past COLLAPSE_AT auto-collapses (owner: no
 *  toggle, the resize itself collapses at a breakpoint). */
const snap = (n: number) => (n < COLLAPSE_AT ? COLLAPSED_W : clampExpanded(n));

// Module store (single inbox per session): in-memory cache + listeners so the
// hook reads are live and the server snapshot is a stable constant.
let cached: number | null = null;
const listeners = new Set<() => void>();

function read(): number {
  if (cached != null) return cached;
  if (typeof window === "undefined") return DEFAULT;
  const saved = Number(localStorage.getItem(KEY));
  cached = Number.isFinite(saved) && saved > 0 ? snap(saved) : DEFAULT;
  return cached;
}

function commit(next: number): void {
  cached = snap(next);
  if (typeof window !== "undefined") {
    localStorage.setItem(KEY, String(cached));
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ListResize {
  width: number;
  /** True once the rail has snapped to the avatar-only collapsed width. */
  collapsed: boolean;
  dragging: boolean;
  /** Spread onto the drag-handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
}

export function useListResize(): ListResize {
  const width = useSyncExternalStore(subscribe, read, () => DEFAULT);
  const collapsed = width < MIN;
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  const startX = useRef(0);
  const startW = useRef(DEFAULT);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    active.current = true;
    startX.current = e.clientX;
    startW.current = read();
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!active.current) return;
    commit(startW.current + (e.clientX - startX.current));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return { width, collapsed, dragging, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
}
