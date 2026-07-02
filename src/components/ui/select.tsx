"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Custom <Select> — the single dropdown primitive for the whole app, replacing
 * every native <select> (their menus can't be styled or animated, and look
 * foreign next to the rest of the UI). A token-styled trigger opens an animated,
 * keyboard-navigable listbox.
 *
 * Robust placement: the listbox is PORTALED to <body> and positioned with
 * `position: fixed` against the trigger's rect — so a `position: absolute` menu
 * can never be clipped by a scrollable/`overflow-hidden` ancestor (the bulk-edit
 * grid scrolls; impeccable's interaction rule warns about exactly this). It
 * closes on outside-pointerdown, scroll, resize, and Escape.
 *
 * Accessibility: button trigger with `aria-haspopup="listbox"` + `aria-expanded`;
 * the listbox owns focus and drives selection via `aria-activedescendant`
 * (options carry `role="option"` + `aria-selected`). Full keyboard support
 * (↑/↓, Home/End, Enter/Space, Esc, Tab, type-ahead) and a `prefers-reduced-motion`
 * path that swaps the spring for an instant cross-fade.
 *
 * Native-form bridge: pass `name` (and optional `form`) to mirror the value into
 * a hidden <input>, so a server-action <form> still submits it exactly like the
 * old `<select name= form=>` did (the review form relies on this).
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown on the trigger when `value` matches no option (e.g. an empty value). */
  placeholder?: string;
  disabled?: boolean;
  /** Trigger id — pair with a <label htmlFor> for an accessible name. */
  id?: string;
  /** Mirror the value into a hidden input so a native <form> still submits it. */
  name?: string;
  /** Associates the hidden input with a <form id> (like `<select form=>`). */
  form?: string;
  title?: string;
  /** Width / padding / text-size for the trigger; structure + state are owned here. */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

interface MenuPos {
  left: number;
  width: number;
  above: boolean;
  /** Exactly one of top/bottom is set (fixed-anchored from the trigger rect). */
  top?: number;
  bottom?: number;
  /** Clamped to the space between the trigger and the viewport edge, so the
   *  menu can never extend off-screen (which would make scrollIntoView scroll
   *  the WINDOW chasing the active option — and the scroll-closes listener
   *  would instantly dismiss the menu). */
  maxHeight: number;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  id,
  name,
  form,
  title,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: SelectProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<MenuPos | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });
  // True while our own scrollIntoView may still emit scroll events — the
  // scroll-closes-menu listener must not treat that as a user scroll.
  const selfScroll = useRef(false);

  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (i: number) => `${reactId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const firstEnabled = useCallback(
    () => options.findIndex((o) => !o.disabled),
    [options],
  );

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip above only when below is genuinely tight AND there's more room up top
    // — anchoring by `bottom` avoids needing the (unrendered) menu height.
    const above = spaceBelow < 280 && r.top > spaceBelow;
    const avail = (above ? r.top : spaceBelow) - 6 - 8;
    setPos({
      left: r.left,
      width: r.width,
      above,
      top: above ? undefined : r.bottom + 6,
      bottom: above ? window.innerHeight - r.top + 6 : undefined,
      maxHeight: Math.max(96, Math.min(256, avail)),
    });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    reposition();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled());
    setOpen(true);
  }, [disabled, reposition, selectedIndex, firstEnabled]);

  const closeMenu = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Position before paint so the menu never flashes at (0,0); focus the listbox.
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    selfScroll.current = false;
    listRef.current?.focus({ preventScroll: true });
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    // capture:true catches scroll on any ancestor (e.g. the bulk-edit grid
    // body) — but the listbox itself is overflow-auto, so scrolls originating
    // inside it (wheel, or scrollIntoView chasing the active option) must not
    // close the menu.
    const onScroll = (e: Event) => {
      if (selfScroll.current) return;
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  // Keep the keyboard-active option in view in a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    selfScroll.current = true;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // Scroll events dispatch during the next rendering update ("run the scroll
    // steps"), before rAF callbacks — so clearing the flag in rAF covers them.
    const raf = requestAnimationFrame(() => {
      selfScroll.current = false;
    });
    return () => cancelAnimationFrame(raf);
    // optionId is derived from a stable reactId; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  const moveActive = (dir: 1 | -1) => {
    setActiveIndex((cur) => {
      const n = options.length;
      if (n === 0) return cur;
      let i = cur < 0 ? (dir === 1 ? -1 : 0) : cur;
      for (let step = 0; step < n; step++) {
        i = (i + dir + n) % n;
        if (!options[i]?.disabled) return i;
      }
      return cur;
    });
  };

  const commit = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    closeMenu();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(firstEnabled());
        break;
      case "End": {
        e.preventDefault();
        let i = options.length - 1;
        while (i > 0 && options[i]?.disabled) i--;
        setActiveIndex(i);
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closeMenu();
        break;
      case "Tab":
        // Close and put focus back on the trigger WITHOUT preventDefault: the
        // listbox is portaled to <body>, so tabbing from it would land at
        // end-of-document (or trip a dialog's focus trap). Refocusing the
        // trigger synchronously lets the browser's default Tab move on to the
        // control after the Select.
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        if (e.key.length === 1) {
          const ta = typeahead.current;
          ta.buffer += e.key.toLowerCase();
          if (ta.timer) clearTimeout(ta.timer);
          ta.timer = setTimeout(() => (ta.buffer = ""), 600);
          const match = options.findIndex(
            (o) => !o.disabled && o.label.toLowerCase().startsWith(ta.buffer),
          );
          if (match >= 0) setActiveIndex(match);
        }
    }
  };

  // Structure + border/disabled states are owned here; the caller's `className`
  // provides bg / text-color / width / padding / text-size (so a Select can match
  // bg-surface forms or bg-bg recessed forms without the base fighting it).
  const triggerClass =
    "inline-flex cursor-pointer items-center justify-between gap-2 rounded-lg border text-left outline-none transition-colors disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint " +
    (open
      ? "border-accent ring-2 ring-accent/25 "
      : "border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 ") +
    className;

  return (
    <>
      {name ? <input type="hidden" name={name} form={form} value={value} /> : null}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={triggerClass}
      >
        <span className={`min-w-0 truncate ${selected ? "" : "text-faint"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className={`size-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* SSR/first-render guard: the menu's AnimatePresence child is gated on
          `open` (false on the server and at hydration), so the portal emits no
          host nodes until the user opens it — no hydration mismatch, and exit
          animations still play because AnimatePresence stays mounted. */}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open && pos ? (
                <motion.ul
                  ref={listRef}
                  role="listbox"
                  id={listboxId}
                  tabIndex={-1}
                  aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                  aria-label={ariaLabel}
                  aria-labelledby={ariaLabelledby}
                  onKeyDown={onListKeyDown}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: pos.above ? 4 : -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: pos.above ? 4 : -4, scale: 0.98 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.15, ease: [0.21, 0.8, 0.32, 1] }}
                  style={{
                    position: "fixed",
                    left: pos.left,
                    top: pos.top,
                    bottom: pos.bottom,
                    minWidth: pos.width,
                    maxHeight: pos.maxHeight,
                    transformOrigin: pos.above ? "bottom center" : "top center",
                  }}
                  className="z-[70] overflow-auto rounded-xl border border-border bg-surface p-1 shadow-lg outline-none"
                >
                  {options.map((o, i) => {
                    const isSelected = o.value === value;
                    const isActive = i === activeIndex;
                    return (
                      <li
                        key={`${o.value}-${i}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={o.disabled || undefined}
                        onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                        onClick={() => commit(i)}
                        className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[14px] transition-colors ${
                          o.disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
                        } ${isActive && !o.disabled ? "bg-surface-2" : ""} ${
                          isSelected ? "font-medium text-accent" : "text-fg"
                        }`}
                      >
                        <span className="min-w-0 truncate">{o.label}</span>
                        {isSelected ? (
                          <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            className="size-4 shrink-0 text-accent"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m5 12 5 5L20 7" />
                          </svg>
                        ) : null}
                      </li>
                    );
                  })}
                </motion.ul>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
