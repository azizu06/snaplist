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

- source-specific constructors parse strict source-owned projections, validate their UUID identities,
  and derive values rather than accepting a caller-supplied count or time window: capture count comes
  from unique session photos, sold count and inclusive UTC-day window come from dated retained comps,
  and uploaded count comes from durable run photo states;
- each constructor enrolls the exact frozen object identity in module-private runtime state and binds
  it to one semantic key; no marker property or enumerable symbol is exposed for object spread,
  descriptor copying, or a caller assertion to forge;
- a verified value is accepted only for its enrolled semantic key, so facts such as `soldCompCount`
  and `windowDays` cannot be swapped even when their source, reference, and integer bounds overlap;
- the durable-item constructor accepts an already tenant-scoped item projection and derives the display
  name only from bounded structured brand, model, or category facts; generated listing titles and other
  free-form model text are never used;
- integers still declare minimum and maximum bounds;
- text still declares a maximum length and a durable provenance reference;
- undeclared, missing, out-of-bounds, or untrusted substitutions fail closed;
- `model-output` is not a trusted source and free-form model text is never accepted.

`approved-copy-provenance.v1.json` maps every semantic state to its frozen native state IDs, exact
templates, canonical resolved copy, and checked-in design authority. Contract tests verify all
source fragments verbatim; accessibility labels compose those approved phrases with verified facts.

The checked-in catalog currently ships approved `en-US` copy. Catalog locale keys are canonical
BCP-47 language tags. A request must contain a well-formed BCP-47 tag; invalid tags fail closed with
`invalid-locale`, while valid tags are canonicalized before lookup. Registered grandfathered tags
use their preferred modern tag when one exists, and canonical private-use tags remain valid even
though they have no language fallback. Locale lookup then tries the canonical requested locale, its
language tag when one exists, and finally `en-US`, in that deterministic order.
New translations must provide the complete dictionary, use the exact approved placeholder set for
each copy key, and contain balanced template braces; they do not change state selection or authorize
new guide moments.

Grammar variants remain catalog copy rather than resolver-written English. A state's
`pluralCopyKeys` selects a declared integer fact, applies `Intl.PluralRules` for the resolved locale,
and chooses that locale's category-specific copy key with the base key as the deterministic fallback.
The V1 price-evidence message therefore renders `1 day` for the `one` category and `days` otherwise.

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
