/**
 * Button class builder — kept OUT of the "use client" button module so Server
 * Components (e.g. link-styled-as-button in publish-view) can call it; a
 * client-module function can only be *rendered*, not invoked, from the server.
 */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Shopify-admin primary: near-black, NOT the brand blue (the blue accent is
  // reserved for the brand mark + the top-bar sell CTA).
  primary:
    "bg-primary text-primary-fg hover:bg-primary-hover border border-transparent shadow-xs",
  secondary:
    "bg-surface text-fg border border-border-strong hover:bg-surface-2 shadow-xs",
  danger:
    "bg-danger-solid text-white hover:opacity-90 border border-transparent shadow-xs",
  ghost: "bg-transparent text-muted hover:bg-surface-2 border border-transparent",
};

const SIZE_CLASSES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
} as const;

export type ButtonSize = keyof typeof SIZE_CLASSES;

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
): string {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-[color,background-color,border-color,transform] duration-100 motion-safe:active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}`;
}
