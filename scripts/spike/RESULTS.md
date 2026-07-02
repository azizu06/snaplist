# Spike #104 — garment measurements from flat-lay photos: results

## Verdict: **INSUFFICIENT-DATA**

Need >=5 with-cue measurements (have 3) and >=5 >=3in-gap pairs (have 50) to call it.

Model(s): `gemini-2.5-flash`, `gemini-2.5-flash-lite` (Google/Gemini, dev provider — pinned; no OpenAI spend). 16 fixtures, 38 matched measurements, 4 seller-stated measurements the model did not return.

### GO bar (agreed 2026-07-02: the "size-class bar")

GO requires, on photos **with** a scale cue: median absolute error ≤ 1.5in **and** ≥ 90% correct ordering of garment pairs whose true measurements differ by ≥ 3in (the "is this the 21in or the 24in pit-to-pit" question buyers actually ask). The stricter ±1in band from issue #104 is reported below but does not decide the verdict alone — seller-stated ground truth is itself only ±~0.5in.

## By scale-cue cohort

| Cohort | n | Median abs err (in) | ≤1.0in | ≤1.5in | ≥3in-gap ordering |
|---|---|---|---|---|---|
| With scale cue | 3 | 0.50 | 67% | 100% | 0/0 (—) |
| Without scale cue | 35 | 1.00 | 57% | 69% | 36/46 (78%) |
| Overall | 38 | 1.00 | 58% | 71% | 40/50 (80%) |

## By measurement

| Measurement | n | Median abs err (in) | ≤1.0in | ≤1.5in |
|---|---|---|---|---|
| pit_to_pit | 12 | 1.00 | 58% | 75% |
| length | 12 | 1.25 | 50% | 67% |
| sleeve | 2 | 3.60 | 50% | 50% |
| shoulder | 1 | 0.50 | 100% | 100% |
| waist | 4 | 0.50 | 100% | 100% |
| rise | 3 | 1.00 | 67% | 100% |
| inseam | 3 | 4.00 | 0% | 0% |
| hip | 1 | 1.00 | 100% | 100% |

## Every prediction vs ground truth

| Fixture | Garment | Cue | Measurement | Seller (in) | Model (in) | Abs err | Method | Model ± |
|---|---|---|---|---|---|---|---|---|
| braves-hoodie-327024382295 | hoodie | yes | pit_to_pit | 22 | 22 | 0.00 | reference-scaled | ±1 |
| braves-hoodie-327024382295 | hoodie | yes | length | 25.5 | 27 | 1.50 | reference-scaled | ±1 |
| levis-painter-jeans-298114744967 | jeans | yes | waist | 16 | 15.5 | 0.50 | reference-scaled | ±0.5 |
| bigstar-capris-381859264711 | pants | no | waist | 15 | 15.5 | 0.50 | prior-based | ±1.5 |
| bigstar-capris-381859264711 | pants | no | inseam | 20 | 29 | 9.00 | prior-based | ±2 |
| bigstar-capris-381859264711 | pants | no | rise | 10 | 9.5 | 0.50 | prior-based | ±1 |
| billblass-jeans-157100443043 | jeans | no | waist | 18 | 19 | 1.00 | prior-based | ±1.5 |
| billblass-jeans-157100443043 | jeans | no | rise | 11.5 | 10.5 | 1.00 | prior-based | ±1 |
| billblass-jeans-157100443043 | jeans | no | inseam | 29 | 25 | 4.00 | prior-based | ±1.5 |
| billblass-jeans-157100443043 | jeans | no | hip | 22 | 23 | 1.00 | prior-based | ±2 |
| champion-sweatshirt-125389445458 | sweatshirt | no | pit_to_pit | 24 | 22 | 2.00 | prior-based | ±2 |
| champion-sweatshirt-125389445458 | sweatshirt | no | length | 25 | 26.5 | 1.50 | prior-based | ±2 |
| harley-tee-127327446790 | tshirt | no | pit_to_pit | 20 | 21 | 1.00 | prior-based | ±2 |
| harley-tee-127327446790 | tshirt | no | length | 25.5 | 28.5 | 3.00 | prior-based | ±2 |
| krt-sweatshirt-236793882491 | sweatshirt | no | pit_to_pit | 20 | 23 | 3.00 | prior-based | ±2 |
| krt-sweatshirt-236793882491 | sweatshirt | no | length | 24 | 28 | 4.00 | prior-based | ±2 |
| leerider-jacket-167582388296 | jacket | no | pit_to_pit | 20.5 | 21.5 | 1.00 | prior-based | ±1.5 |
| leerider-jacket-167582388296 | jacket | no | length | 23.5 | 24.5 | 1.00 | prior-based | ±1.5 |
| leerider-jacket-167582388296 | jacket | no | shoulder | 18.5 | 18 | 0.50 | prior-based | ±1.5 |
| leerider-jacket-167582388296 | jacket | no | sleeve | 24 | 24 | 0.00 | prior-based | ±1.5 |
| maryland-sweatshirt-227297660423 | sweatshirt | no | pit_to_pit | 24 | 23 | 1.00 | prior-based | ±2 |
| maryland-sweatshirt-227297660423 | sweatshirt | no | length | 27 | 27 | 0.00 | prior-based | ±2 |
| motto-jeans-176931578282 | jeans | no | waist | 16.5 | 17 | 0.50 | prior-based | ±2 |
| motto-jeans-176931578282 | jeans | no | inseam | 31 | 29 | 2.00 | prior-based | ±2 |
| motto-jeans-176931578282 | jeans | no | rise | 11.5 | 10 | 1.50 | prior-based | ±2 |
| notag-tee-375743877242 | tshirt | no | pit_to_pit | 21 | 22.5 | 1.50 | prior-based | ±1.5 |
| notag-tee-375743877242 | tshirt | no | length | 26 | 28.5 | 2.50 | prior-based | ±1.5 |
| starter-tee-295475995846 | tshirt | no | pit_to_pit | 25 | 25 | 0.00 | prior-based | ±1.5 |
| starter-tee-295475995846 | tshirt | no | length | 33 | 31 | 2.00 | prior-based | ±1.5 |
| wander-tee-197225803887 | tshirt | no | pit_to_pit | 22.5 | 22 | 0.50 | prior-based | ±2 |
| wander-tee-197225803887 | tshirt | no | length | 27 | 28 | 1.00 | prior-based | ±2 |
| whitesville-hoodie-206171217363 | hoodie | no | pit_to_pit | 19.7 | 21 | 1.30 | prior-based | ±2 |
| whitesville-hoodie-206171217363 | hoodie | no | length | 25.6 | 26 | 0.40 | prior-based | ±2 |
| whitesville-hoodie-206171217363 | hoodie | no | sleeve | 24.8 | 32 | 7.20 | prior-based | ±2 |
| wrangler-jacket-206017123189 | jacket | no | pit_to_pit | 26 | 22.5 | 3.50 | prior-based | ±2 |
| wrangler-jacket-206017123189 | jacket | no | length | 26 | 25 | 1.00 | prior-based | ±2 |
| yale-hoodie-358536824431 | hoodie | no | pit_to_pit | 25 | 24 | 1.00 | prior-based | ±2 |
| yale-hoodie-358536824431 | hoodie | no | length | 28 | 28 | 0.00 | prior-based | ±2 |

## Method & caveats

- **Gold data:** real eBay listings where the seller stated flat-lay measurements; each photo visually verified as a flat-lay. Provenance URLs in `fixtures/fixtures.json`; the photos themselves are **not** committed (public repo, sellers' images) — `fetch-images.ts` re-materializes them locally.
- **Ground-truth noise:** sellers measure by hand; ±0.5in of the reported error is plausibly the seller's, not the model's. That is why the verdict uses the size-class bar rather than the raw ±1in band.
- **One call per fixture.** Most fixtures are a single photo; the two scale-cue fixtures include 2–3 photos (tape close-up + full flat-lay), matching the product's 1–4-photo vision call and how measurement-photographing sellers actually shoot.
- **Model split (quota):** the 14 no-cue fixtures ran on `gemini-2.5-flash`; the 2 cue fixtures ran on `gemini-2.5-flash-lite` after the free-tier daily cap was hit. The weaker model on the decisive arm biases AGAINST the reference-scaling hypothesis, so its strong showing is conservative — but a same-model rerun after quota reset is the cheap follow-up before trusting it.
- **`method` is the model's self-report**; the cohort split uses the fixture's human-verified `scale_cue` flag, not the model's claim.
- Fixtures rot as listings end; the verdict table above is the durable artifact.

