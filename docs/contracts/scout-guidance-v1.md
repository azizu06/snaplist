# Scout guidance contract V1

`scout-guidance-v1.json` is the provider-neutral launch catalog for Scout guidance. Product code
resolves a semantic state through `resolveScoutGuidance`; it does not ask a model to write guide
copy. The catalog is subordinate to `PRD.md`, ADR-0008, and the approved native V1 design inventory.

## Request and result

A request contains the literal contract version, one supported semantic state, a BCP 47 locale, and
only the substitutions declared for that state. The result contains deterministic visible copy,
one deterministic accessibility label, the resolved locale and fallback chain, and guide metadata.
The same request always produces the same result.

Substitutions are narrow facts, not prose extensions:

- integers declare minimum and maximum bounds;
- text declares a maximum length, a trusted source, and a durable provenance reference;
- undeclared, missing, out-of-bounds, or untrusted substitutions fail closed;
- `model-output` is not a trusted source and free-form model text is never accepted.

The checked-in catalog currently ships approved `en-US` copy. Locale lookup tries the canonical
requested locale, then its language tag, then `en-US`. New translations add locale dictionaries;
they do not change state selection or authorize new guide moments.

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
