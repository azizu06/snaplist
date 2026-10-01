# Model generation screening — 2026-10-01

The original screening below retained Terra. The later owner-approved
[Luna runtime profile](../../../unit-economics/runtime-profile-2026-10-01.md) supersedes
that selection, with explicit role efforts and GPT-Transcribe for completed recordings.
Historical samples retain their original omitted-effort semantics; they do not measure
the new mixed profile or prove production-key access.

Keep the OpenAI defaults at **gpt-5.6-terra for all five roles** for the Shipaton demo. Keep voice notes at **gpt-4o-mini-transcribe** and embeddings at **text-embedding-3-small**. No runtime, production environment, account, billing, or phone configuration changed.

## Official capabilities, rates, tiers and discounts

Verified on 2026-10-01 using the signed-in OpenAI platform and official documentation. Prices below are USD per million tokens for Standard short context (up to 272K input tokens), in input / cached input / output order.

| Model | Modalities and structured outputs | Standard rate | Latency/service choices |
|---|---|---:|---|
| [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | Text and image input; text output; structured output | $2 / $0.20 / $12 | Standard; Batch/Flex; Fast |
| [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | Text and image input; text output; structured output | $0.10 / $0.01 / $0.50 | Standard; Batch/Flex; Fast |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | Text and image input; text output; structured output | $2 / $0.10 / $10 | Standard; Batch/Flex; Fast |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | Text and image input; text output; structured output | $10 / $1 / $50 | Standard; Batch/Flex; Fast; Ultrafast |

The [pricing page](https://developers.openai.com/api/docs/pricing) lists Batch and Flex at 50% below Standard, Fast at 2× Standard and Astra Ultrafast at 6× Standard. These are service choices, not a verified account-wide discount on ordinary synchronous calls. [Flex](https://developers.openai.com/api/docs/guides/flex-processing) trades cost for slower responses and occasional resource unavailability; Batch is asynchronous. Neither is adopted for the demo. No expiry is stated for these service rate cards. The pricing page's time-limited GPT-5.6 Sol offer runs at least through November 21, 2026; it does not establish a promotion for these 6.x candidates. The inspected signed-in home page announced GPT-6.1 Sol but did not expose account-specific 50% terms or an expiry. Any separate account offer remains unverified and is excluded from costs.

All candidates support the existing structured Chat Completions calls, confirmed by the live screen. GPT-6.1 Sol's Chat Completions support excludes tool calling; Luna requires reasoning `none` for Chat function calling. The current pricing wrapper extracts structured comps from externally fetched snippets and does not call Chat functions. Built-in tool migrations would require Responses API evaluation. Reasoning settings were left at each production wrapper's default, so these results are not an optimized reasoning-effort comparison.

A newer [gpt-transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe) supports audio/text input, text output and transcription/streaming. The official rate is $0.0045/minute versus mini-transcribe's $0.003/minute (+50%). No fixed audio fixture was available in this run, so quality, latency and adapter compatibility remain unmeasured; retain mini-transcribe. A 15-second note is approximately $0.001125 versus $0.000750. Keep the 1536-dimension embedding model; its $0.02/M token rate and pgvector dimension contract remain unchanged.

## Reproducible method

Receipt: [screening.json](./screening.json), including base source SHA, harness SHA256, photo hashes, outputs and token receipts. Harness: [benchmark-model-generations.ts](../../../../scripts/benchmark-model-generations.ts); spend fence: [benchmark-model-budget.ts](../../../../scripts/benchmark-model-budget.ts).

The existing eval fixtures supply Sony WH-1000XM4 and the human-labeled generic mug for listing/export, and two human-labeled listings for judge calibration. Pricing repeats the existing web-search test's two sold amounts and one asking amount with distinct fixture URLs; these are canned evidence, not live sold-comps research. Vision uses the existing public AirPods Max and DualSense demo photos, resized in memory to a single image bounded by 512×512. Both fixtures run against all four models, reversing model order on the second fixture.

The screen calls the actual stage generators and schemas, then the existing public reconciliation/repair wrappers. It uses 40 calls. The follow-up uses the real vision pipeline, confidence calculation, listing generator and PriceRouter with **LLM-only pricing**, local photo downloads and no retrieval examples: eight complete candidates, three requests each. Pricing and listing may overlap inside that pipeline. These 24 calls are not a live sold/web routing benchmark. There are zero database writes or marketplace calls.

Standard/default service, 2048 completion tokens including reasoning, unchanged wrapper reasoning defaults, a 120-second per-request deadline, a cumulative request cap and conservative per-request spend reservations bound the live run. Unknown charges retain their reservation. Every one of 64 requests returned usage; total measured token cost was **$0.3201833**, unknown reserved cost **$0**, below the final $1.20 cap. The earlier screening receipt records its original $1.25 ceiling; the completion phase tightened the cumulative ceiling to $1.20. No funds were added. The one authorized restricted benchmark key expired October 2 and was explicitly revoked October 1; dashboard readback showed benchmark **Revoked**, production key **Active**, and credit balance **$1.66**. The local Keychain copy was deleted. Dashboard usage can lag token receipts.

Default invocation is offline and prints a zero-call plan:

```sh
pnpm exec tsx scripts/benchmark-model-generations.ts
```

Live execution requires an explicitly authorized temporary inference credential in login Keychain (`snaplist-openai-benchmark`, account `benchmark`). `--live` refuses to overwrite an existing paid receipt. `--live --complete-listings` reads that screen, carries its spend forward and refuses repeated/uncertain completion. Do not rerun this committed receipt or create another credential without a new bounded benchmark authorization.

## Stage latency and quality

Times are seconds, **nearest-rank empirical p50 / p95 with n=2 per stage/model**. At this sample size they are the observed minimum / maximum, not stable tail estimates or reliability evidence. Schema success was 2/2 for every cell.

| Stage | Terra | Luna | Sol 6.1 | Astra |
|---|---:|---:|---:|---:|
| vision | 2.867 / 3.055 | 2.412 / 2.896 | 5.384 / 9.463 | 3.563 / 3.631 |
| listing | 2.213 / 3.971 | 3.978 / 6.662 | 6.359 / 6.555 | 4.290 / 5.971 |
| export | 1.647 / 1.838 | 2.589 / 2.774 | 5.629 / 6.148 | 4.458 / 4.473 |
| pricingAgent | 1.911 / 2.782 | 2.983 / 3.490 | 2.990 / 3.145 | 2.913 / 2.975 |
| judge | 1.220 / 1.653 | 4.584 / 6.121 | 3.293 / 4.610 | 3.031 / 3.873 |

| Stage | Quality observations | Decision and rollback override |
|---|---|---|
| Vision | Every model recognized both brand/families. Luna's empirical p50/p95 is lower, but its AirPods sample is slightly slower and condition/variant details vary. Two clean single-photo families cannot establish equal quality across barcode, difficult identity, voice contradiction, or multi-photo inputs. | **Kept Terra**; broader quality and latency gate unproved. `VISION_MODEL` |
| Listing | All heuristic overall scores 4/5; grounded scores 5/5. Luna gains one mug title point. Heuristics and repaired descriptions cannot certify seller-facing quality equality. Every candidate's p50 and p95 increased. | **Kept Terra**; observed latency regression. `LISTING_MODEL` |
| Export | Raw grounding check passed Terra 0/2, Luna 1/2, Sol 0/2, Astra 1/2; the existing conservative matcher/repair is part of the public seam. A raw rejection is not a proven seller-visible hallucination. Every candidate's p50/p95 increased. | **Kept Terra**; observed latency regression, quality proof insufficient. `EXPORT_PACK_MODEL` |
| Pricing agent | All models extracted exact prices, kinds and URLs on 2/2 canned inputs. Actual retrieval and variable/noisy evidence remain unmeasured. Every candidate's p50/p95 increased. | **Kept Terra**; observed latency regression. `PRICING_MODEL` |
| Judge | Terra matched human overall scores within one point on 2/2; each candidate on 1/2. On the flawed electronics example each candidate differed by three grounded points and two overall points. | **Kept Terra**; worse sampled human agreement and latency. `EVAL_JUDGE_MODEL` |
| Voice | Newer gpt-transcribe is 50% dearer; no audio eval in this run. | **Kept mini-transcribe**; quality/latency gate unproved. `SELLER_CONTEXT_TRANSCRIPTION_MODEL` |
| RAG embeddings | Optional/default-off retrieval; 1536-dimensional storage lock. No embedding comparison needed for these language-model candidates. | **Kept text-embedding-3-small**. |

Judge candidates were calibrated against existing human labels before interpreting them. They were not used to score their own generated listings. Human review of these candidate outputs is still needed for any future quality approval.

## Complete draft candidate economics

A candidate is counted when the actual pipeline produces an identified item, normalized price/range, coherent confidence and schema-valid editable eBay draft. This is **not a durable usable-listing receipt**: there is no DB settlement, seller correction, publish, verified condition, or sold-price truth. Titles/descriptions may use existing deterministic repair/fallback. Condition and LLM-only price vary (DualSense estimates $30–$50), so schema validity cannot establish equal quality.

| Model for vision + fallback price + listing | Candidates | Pipeline p50 / p95 (s) | Mean token cost per accepted candidate |
|---|---:|---:|---:|
| gpt-5.6-terra | 2/2 | 5.103 / 6.089 | $0.0093310 |
| gpt-6-luna | 2/2 | 5.062 / 8.784 | $0.0005720 |
| gpt-6.1-sol | 2/2 | 12.039 / 12.790 | $0.0084982 |
| gpt-6-astra | 2/2 | 7.757 / 9.312 | $0.0385420 |

These are model-only costs under the no-evidence fallback route, including all requests made for each candidate. Export, judge, transcription, web/sold provider fees, infrastructure, retries, failed durable runs and included corrections are excluded. Full production cost per durable usable listing remains unmeasured. The [unit-economics assessment](../../../unit-economics/model-generation-assessment-2026-10-01.md) records this distinction and leaves the dated July allowance calculator intact.

## Delivery boundaries

No defaults switched; every existing role override remains a one-env-change rollback seam. No production env change is proposed, so recording prior production model values and proving switched-stage access through a Vercel preview are not applicable. Temporary-key access does not prove production-key access.

Graphify: **no graph impact**. Changes add benchmark evidence, a benchmark-only budget seam and economics prose; no path in `docs/architecture/graphify-core-scope.txt` changes, and no production dependency relationship changes. No generated Graphify output is committed.

Review round: **0/3**. The direct-PR worker contract prohibits delegation; fresh Standards/Spec review remains with Firstmate/merge authority. The approved brief freezes this slice to evaluation/evidence and permits keeping defaults when adoption gates do not pass. TDD covers the spend boundary; model quality uses fixture evaluation rather than exact-text unit tests. No product behavior or PRD decision changes.

Validation: 21 focused test files / 454 tests passed (budget fence, registry, eval, vision pipeline,
listing/export contracts, pricing wrappers and offline runtime benchmark); `pnpm typecheck`;
ESLint with zero warnings on the three new scripts; `pnpm eval` (36 stored predictions,
offline heuristic judge, not new model quality); `pnpm unit-economics:check`; offline benchmark
plan; and receipt count/hash/status checks. All 64 HTTP responses were 200 with `stop` finish
reasons, so no recorded request exhausted the completion cap.
