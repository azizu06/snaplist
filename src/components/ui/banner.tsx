/**
 * Banner (audit X-8): the one way async results and statuses speak in prose.
 * Replaces the bare `?error=` red paragraphs. `action` slots a recovery
 * affordance (retry button, link) directly inside the message.
 */

export type BannerVariant = "info" | "success" | "warning" | "error";

const VARIANT_CLASSES: Record<BannerVariant, string> = {
  info: "border-info-border bg-info-soft text-info-soft-fg",
  success: "border-success-border bg-success-soft text-success-soft-fg",
  warning: "border-warning-border bg-warning-soft text-warning-soft-fg",
  error: "border-danger-border bg-danger-soft text-danger-soft-fg",
};

export function Banner({
  variant,
  title,
  children,
  action,
}: {
  variant: BannerVariant;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section
      role={variant === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 ${VARIANT_CLASSES[variant]}`}
    >
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-0.5 text-xs opacity-90">{children}</div> : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </section>
  );
}
