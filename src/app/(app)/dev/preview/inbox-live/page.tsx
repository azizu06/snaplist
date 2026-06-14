"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { InboxEmptyState } from "@/app/(app)/inbox/inbox-empty";
import { SimulatorCard } from "@/app/(app)/inbox/simulator-card";
import type { ItemOption } from "@/app/(app)/inbox/inbox-client";

/**
 * DEV-ONLY inbox preview (app-surfaces v3; /dev/preview/inbox-live — a static
 * sibling of the [screen] harness, proxy-whitelisted under /dev). The real
 * /inbox needs a running
 * Supabase stack (Realtime + RLS reads); this renders the SAME surface
 * composition — header, simulator card, empty messages state — from fixtures
 * so the screen can be screenshot-iterated like the /dev/preview harness.
 * Hard-gated out of production builds.
 */

const FIXTURE_ITEMS: ItemOption[] = [
  { id: "fx-1", label: "Sony WH-1000XM4" },
  { id: "fx-2", label: "LEGO Millennium Falcon 75257" },
  { id: "fx-3", label: "Patagonia Better Sweater M" },
];

export default function InboxDevPreviewPage() {
  const [selectedItem, setSelectedItem] = useState(FIXTURE_ITEMS[0].id);
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Buyer inbox
        </h1>
        <p className="mt-0.5 text-[14px] text-muted">
          Questions from buyers appear here live. We draft a reply from the
          listing, then you approve or edit before anything sends.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <SimulatorCard
          items={FIXTURE_ITEMS}
          selectedItem={selectedItem}
          onSelectItem={setSelectedItem}
          onSimulate={() => {}}
          live
          simulating={false}
        />
        <section className="flex flex-col gap-3">
          <h2 className="text-[14px] font-semibold text-fg-strong">Messages</h2>
          <InboxEmptyState />
        </section>
      </div>
    </main>
  );
}
