/**
 * Card primitives (audit X-6, Shopify-style section cards): bordered surface,
 * optional header row with title + aside (chip, action, link).
 */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-surface shadow-xs ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  aside,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
      <h2 className="text-[14px] font-semibold text-fg-strong">{title}</h2>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-4 sm:px-5 ${className}`}>{children}</div>;
}
