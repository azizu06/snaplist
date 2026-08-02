import { VALUE_CARDS } from "@/lib/marketing/site";

/** Line icons, keyed by card id. Decorative — every card states its own title. */
const ICONS: Record<string, React.ReactNode> = {
  review: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  evidence: (
    <>
      <path d="M6 3h9l4 4v9a2 2 0 0 1-2 2h-2" />
      <circle cx="9" cy="15" r="4" />
      <path d="m12 18 3 3" />
    </>
  ),
  publish: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
};

export function ValueCards() {
  return (
    <div className="mkt-cards">
      {VALUE_CARDS.map((card) => (
        <div key={card.id} className="mkt-card">
          <span className="mkt-card__icon">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ICONS[card.id]}
            </svg>
          </span>
          <h3 className="mkt-card__title">{card.title}</h3>
          <p className="mkt-card__body">{card.body}</p>
        </div>
      ))}
    </div>
  );
}
