/**
 * EmptyState (audit X-7, Depop pattern): plain-language headline + one CTA.
 * Every list/collection surface renders this instead of a blank panel.
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <p className="text-base font-semibold text-fg-strong">{title}</p>
      {detail ? <p className="max-w-sm text-sm text-muted">{detail}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
