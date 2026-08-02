import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SnapList pricing",
  description: "SnapList pricing will be announced at launch.",
};

export default function PricingPage() {
  return (
    <section className="mkt-section mkt-pricing">
      <div className="mkt-shell mkt-shell--prose">
        <p className="mkt-pricing__eyebrow">Pricing</p>
        <h1 className="mkt-h1">Simple from first listing to Pro.</h1>
        <div className="mkt-pricing__card">
          <p>Your first listing is free.</p>
          <p>SnapList Pro is an App Store subscription.</p>
          <p>Pricing will be announced at launch.</p>
        </div>
      </div>
    </section>
  );
}
