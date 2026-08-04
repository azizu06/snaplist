import type { Metadata } from "next";
import Link from "next/link";
import { SupportChannel } from "@/components/marketing/support-channel";
import { FAQ_ITEMS } from "@/lib/marketing/site";

/**
 * Support page.
 *
 * App Review requires a resolvable support URL before submission, and no such
 * page existed in this repository. The answers reuse `FAQ_ITEMS` rather than
 * restating them, so a correction to a product claim cannot land on the landing
 * page and miss this one.
 */
export const metadata: Metadata = {
  title: "Support — SnapList",
  description: "How SnapList works, common questions, and how to reach a person.",
};

export default function SupportPage() {
  return (
    <section className="mkt-shell mkt-shell--prose mkt-doc">
      <h1>Support</h1>
      <p className="mkt-doc__meta">Help with SnapList for iPhone</p>

      <h2>Contact</h2>
      <SupportChannel context="support" />
      <p>
        When you write in, it helps to say what the item was and what SnapList did or did not do
        with it. If a listing came out wrong, the title it produced is usually enough for us to
        find the run.
      </p>

      <h2>Common questions</h2>
      {FAQ_ITEMS.map((item) => (
        <div key={item.id}>
          <h3>{item.question}</h3>
          <p>{item.answer}</p>
        </div>
      ))}

      <h2>Deleting your data</h2>
      <p>
        You can delete an item, or your whole account, from inside the app. The{" "}
        <Link href="/privacy">privacy policy</Link> describes what each of those removes and how
        long anything is kept.
      </p>
    </section>
  );
}
