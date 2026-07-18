# Scout guidance contract V1

`src/lib/scout-guidance/catalog.v1.json` is the provider-neutral launch catalog for Scout guidance.
Product code resolves a semantic state through `resolveScoutGuidance`; it does not ask a model to
write guide copy. The catalog is subordinate to `PRD.md`, ADR-0008, and the approved native V1
design inventory.

## Request and result

A request contains the literal contract version, one supported semantic state, a BCP 47 locale, and
only the substitutions declared for that state. The result contains deterministic visible copy,
one deterministic accessibility label, the resolved locale and fallback chain, and guide metadata.
The same request always produces the same result.

Substitutions are opaque verified facts, not caller-labelled objects or prose extensions:

- source-specific constructors derive provenance and validate real UUID identifiers;
- runtime trust for capture, upload, and durable item facts is private object identity, so copying or spreading a fact never
  copies its authority;
- sold-count and day-window facts accept only the immutable snapshot carried from an approved
  sold-provider route. The durable worker writes one full pricing result plus a compact projection
  of its approved provider, sold count, and evidence timestamps into the lease-fenced,
  service-role-written `pipeline_runs.checkpoint`. A server-runtime-only loader reads the row through
  the caller's tenant/RLS client, verifies the projection against the saved price, and re-enrolls
  authority after JSON persistence or process restart. Raw checkpoint JSON and tenant-writable
  prediction-log source fields never grant authority. Pricing sources are bounded at the router to
  the public eBay provider's 60-result ceiling. Citation URLs must be absolute HTTP(S); external
  URLs fail soft when invalid or oversized, public-eBay provenance requires an eBay item URL, and
  ISBN catalog metadata falls back to canonical Open Library/Google Books records when its supplied
  link leaves the owning provider. Display titles are truncated without splitting Unicode code
  points, external U+0000 is repaired, and the shared source contract rejects U+0000 or malformed
  surrogate strings before PostgreSQL JSONB persistence.
  The worker rejects checkpoints above the
  database's 262,144-byte JSONB-text ceiling before attempting the RPC. Its byte calculation expands
  exponent-form numbers to PostgreSQL's JSONB decimal representation. The ordered production
  wrapper and ISBN transformation preserve authority
  while Scout derives both values from unique dated citations with one shared observation time;
- upload-count facts come from producer-owned attempt snapshots, and the completed count advances
  only after Storage succeeds; observer failures cannot
  change upload/staging outcomes, and paused copy describes only what finished in that attempt. It does
  not imply device durability or reconnect resumption;
- the durable-item constructor accepts only the exact snapshot object returned by the existing
  tenant-scoped review RPC loader and derives the display name from bounded structured brand/model
  facts, then category. It never substitutes the free-form title, and unsafe structured prose fails
  closed; later caller mutation cannot relabel the private item projection captured at load time;
- a durable item without an approved display-name fact fails closed; V1 has no generic item-name
  template;
- integers still declare minimum and maximum bounds;
- text still declares a maximum length and a durable provenance reference;
- undeclared, missing, out-of-bounds, or untrusted substitutions fail closed;
- `model-output` is not a trusted source and free-form model text is never accepted.

`approved-copy-provenance.v1.json` maps every semantic state to its frozen native state IDs, exact
templates, canonical resolved copy, and checked-in design authority. Contract tests verify all
source fragments verbatim; accessibility labels compose those approved phrases with verified facts.
States whose package entries omit visible copy, plus safety corrections where frozen wording exceeds
proven runtime state, use the explicit machine-readable repo override at
`docs/design/scout-guidance-copy-overrides.v1.json`, never an implementation-source text search.

The checked-in catalog currently ships `en-US` and `es` copy. Locale lookup tries the canonical
requested locale, then its language tag, then `en-US`. Every translation must provide the complete
state dictionary and plural formats, use the exact approved placeholder set for each copy key, and
contain balanced template braces. `docs/design/scout-guidance-locales.v1.json` records the approved
exact-copy digest for every shipped locale, including auxiliary formats, and contract tests audit
each locale's copy quality. Translations do not change state selection or authorize new guide
moments.

## Runtime composition

The `/api/health` route resolves one static V1 state through the public Scout barrel, so production
composition includes and validates the catalog without adding a UI or model call. Docker builds
then boot the exact pruned `.next/standalone` server with non-secret local auth placeholders and
verify that health response through `pnpm verify:standalone-scout`. A successful image build
therefore proves the runner artifact contains and executes the resolver and catalog, not merely
that `next build` completed.

## Presentation boundary

`guide.optional` means the Scout presentation is never required to complete the action.
`functionalPurpose` records why the guide may appear. Guidance is nonpersistent, never blocks the
primary action, never becomes a chat surface, and never loops. Reduced Motion always uses the static
state. Scout assets are decorative because the complete state meaning is present in the localized
text and accessibility label.

An entry may intentionally have `scoutAsset: null`. For example, the approved Home empty state has
functional copy but no Scout placement. Asset IDs and source state IDs are contract-tested against
the implementation-frozen inventory and approved asset manifests, so candidate and withheld design
families cannot enter this catalog accidentally.

## Versioning

Copy corrections or translations that preserve semantics may remain in V1. Adding or changing a
semantic state, substitution trust boundary, accessibility meaning, or guide behavior requires a
new contract version and a compatible resolver path.
