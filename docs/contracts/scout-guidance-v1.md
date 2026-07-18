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
- sold-count and day-window facts accept only persisted recommendations whose unique dated sold
  citations carry one router-stamped approved-provider provenance and a shared observation time;
  Scout derives both values after the pricing schema and JSON boundary without adding a policy field;
- upload-count facts come from producer-owned attempt snapshots, and the completed count advances
  only after Storage succeeds; observer failures cannot
  change upload/staging outcomes, and paused copy describes only what finished in that attempt. It does
  not imply device durability or reconnect resumption;
- the durable-item constructor accepts only the exact snapshot object returned by the existing
  tenant-scoped review RPC loader and derives the display name from the private item projection
  captured at load time, so later caller mutation cannot relabel it;
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

The checked-in catalog currently ships approved `en-US` copy. Locale lookup tries the canonical
requested locale, then its language tag, then `en-US`. New translations must provide the complete
dictionary, use the exact approved placeholder set for each copy key, and contain balanced template
braces; they do not change state selection or authorize new guide moments.

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
