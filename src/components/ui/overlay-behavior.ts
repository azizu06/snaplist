"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

/**
 * Shared overlay keyboard behavior (issue #105). The bell + profile menus and
 * the Select primitive each close on Escape; the dashboard popovers, the
 * confirm dialog, and the bulk-edit editor didn't — breaking a contract the
 * app itself teaches. These hooks are the one place that behavior lives so a
 * new overlay can't ship without it.
 */

/** Close on Escape while `active`. Skips events an inner control already
 *  handled (`defaultPrevented`) — e.g. the Select primitive's own Escape
 *  closes just the select, not the dialog hosting it. */
export function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus management: on open, remember the trigger, move focus to the
 * container's `[data-autofocus]` element (fallback: first focusable); on
 * unmount, return focus to the trigger. With `trap`, Tab cycles inside the
 * container (dialogs); popover menus skip the trap so Tab can leave naturally.
 */
export function useModalFocus(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  { trap = true }: { trap?: boolean } = {},
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const initial =
      container.querySelector<HTMLElement>("[data-autofocus]") ??
      container.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!trap || e.key !== "Tab") return;
      const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !container.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !container.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [active, containerRef, trap]);
}

/**
 * Arrow-key roving for `role="menu"` popovers — attach as `onKeyDown` on the
 * menu container. Moves focus across the menu's `[role^="menuitem"]` children
 * (ArrowUp/Down wrap, Home/End jump), which is the behavior the `menu` role
 * promises assistive tech.
 */
export function menuArrowNav(e: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
  ];
  if (items.length === 0) return;
  e.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home" || (e.key === "ArrowDown" && current === -1)
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}
