import { TROPHY_WALL_ROWS } from "@/lib/marketing/site";

/**
 * Marketing phone screens for the feature explorer.
 *
 * Nothing here may show a state the product does not have; the Publish screen
 * in particular labels Mercari, Facebook Marketplace, and Depop as assisted
 * handoffs rather than destinations SnapList posts to.
 *
 * The 9px uppercase field labels are decorative chrome. They sit below AA on
 * purpose and repeat nothing the page does not also state at full size.
 */

export function ScanScreen() {
  return (
    <div className="mkt-scr mkt-scr__capture">
      <div className="mkt-scr__capture-bar">
        <span style={{ fontSize: 13, fontWeight: 600 }}>Scan</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#C9CDD6" }}>3 of 5</span>
      </div>
      <div className="mkt-scr__viewfinder" />
      <div className="mkt-scr__strip">
        <div className="mkt-scr__thumb" />
        <div className="mkt-scr__thumb" />
        <div className="mkt-scr__thumb" />
      </div>
      <div className="mkt-scr__shutter-row">
        <div className="mkt-scr__shutter" />
      </div>
    </div>
  );
}

export function PhotoReviewScreen() {
  return (
    <div className="mkt-scr">
      <div className="mkt-scr__bar" style={{ justifyContent: "flex-start" }}>
        <span className="mkt-scr__title">Photo Review</span>
      </div>
      <div className="mkt-scr__body" style={{ gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {[1, 2, 3].map((n) => (
            <div key={n} className="mkt-scr__tile">
              <span>{n}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="mkt-scr__tool">Crop</div>
          <div className="mkt-scr__tool">Rotate</div>
        </div>
      </div>
    </div>
  );
}

export function ListingReviewScreen() {
  return (
    <div className="mkt-scr">
      <div className="mkt-scr__bar">
        <span className="mkt-scr__title">Listing Review</span>
        <span className="mkt-scr__pill">Draft</span>
      </div>
      <div className="mkt-scr__body">
        <Field label="Title" value="Wool blend scarf, gray" />
        <Field label="Condition" value="Used, good" />
        <Field label="Item specifics" value="Gray, one size, wool blend" />
        {/* The no-evidence case is the one the page shows, because a marketing
            frame that always finds comps sets an expectation the router cannot
            keep. This wording matches the product's own no-evidence copy. */}
        <Field label="Price" value="No sold matches found. You set the price." filled />
      </div>
      <div className="mkt-scr__cta">Confirm listing</div>
    </div>
  );
}

export function PublishScreen() {
  return (
    <div className="mkt-scr">
      <div className="mkt-scr__bar" style={{ justifyContent: "flex-start" }}>
        <span className="mkt-scr__title">Publish</span>
      </div>
      <div className="mkt-scr__body" style={{ gap: 14 }}>
        <div className="mkt-scr__cta" style={{ margin: 0, height: 48 }}>
          Confirm and publish to eBay
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {["Mercari", "Facebook Marketplace", "Depop"].map((name) => (
            <div key={name} className="mkt-scr__handoff">
              <span className="mkt-scr__handoff-name">{name}</span>
              <span className="mkt-scr__pill">Assisted handoff</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TrophyWallScreen() {
  return (
    <div className="mkt-scr">
      <div className="mkt-scr__bar" style={{ justifyContent: "flex-start" }}>
        <span className="mkt-scr__title">Trophy Wall</span>
      </div>
      <div className="mkt-scr__body" style={{ gap: 10, padding: "14px 16px" }}>
        {TROPHY_WALL_ROWS.map((row) => (
          <div key={row.id} className="mkt-trophy__row">
            <div className="mkt-trophy__row-art" />
            <span className="mkt-trophy__row-title">{row.title}</span>
            <span className="mkt-trophy__state">{row.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  filled = false,
}: {
  label: string;
  value: string;
  filled?: boolean;
}) {
  return (
    <div className={filled ? "mkt-scr__field mkt-scr__field--filled" : "mkt-scr__field"}>
      <div className="mkt-scr__label">{label}</div>
      <div className="mkt-scr__value">{value}</div>
    </div>
  );
}
