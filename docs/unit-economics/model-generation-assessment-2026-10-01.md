# Model rates and draft economics — October 1, 2026

Keep GPT-5.6 Terra for vision, listing, export, pricingAgent and judge. The
[live screening report](../benchmarks/model-generations/2026-10-01/REPORT.md)
contains fixtures, per-stage quality/latency, service terms, provenance and receipts.
No production defaults or model environment values change.

## Current rates

Official [OpenAI pricing](https://developers.openai.com/api/docs/pricing), verified October 1.
USD per million short-context Standard tokens:

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| GPT-5.6 Terra (retained) | $2.00 | $0.20 | $12.00 |
| GPT-6 Luna | $0.10 | $0.01 | $0.50 |
| GPT-6.1 Sol | $2.00 | $0.10 | $10.00 |
| GPT-6 Astra | $10.00 | $1.00 | $50.00 |

Batch/Flex rates are 50% lower, with asynchronous scheduling or slower/occasionally unavailable
processing. They are excluded from the demo path and this Standard-cost comparison. No general
6.x account promotion was verified. Rates have no stated expiry; the separate GPT-5.6 Sol
time-limited offer is stated to continue at least through November 21, 2026.

Voice remains mini-transcribe at $0.003/minute. Newer GPT-Transcribe is $0.0045/minute; a maximum
15-second note costs approximately $0.000750 versus $0.001125. Without audio quality/latency
evidence, a newer name alone does not justify that increase. Embeddings remain
text-embedding-3-small at $0.02/M tokens with the 1536-dimension lock; optional retrieval is off
by default.

## Measured cost per complete draft candidate

Two public single-photo fixtures per model, real vision pipeline and listing generator, the real
PriceRouter restricted to LLM-only fallback, no DB writes or external search. All eight outputs
passed the pipeline result schema. Existing deterministic listing repair/fallback remains active.

| Model for all three stages | Token cost / accepted draft candidate | Observed latency range |
|---|---:|---:|
| GPT-5.6 Terra | $0.0093310 | 5.103–6.089 s |
| GPT-6 Luna | $0.0005720 | 5.062–8.784 s |
| GPT-6.1 Sol | $0.0084982 | 12.039–12.790 s |
| GPT-6 Astra | $0.0385420 | 7.757–9.312 s |

Numerator includes every paid model request for these drafts; denominator counts schema-valid
complete candidates (2/model). This does not measure durable usable listings: there is no
database credit settlement or seller assessment. LLM-only price and condition vary, and no sold
price truth is available. Export/judge/transcription, web and sold-provider fees, storage/compute,
durable failures and included corrections are excluded. Do not use these figures as subscriber
COGS or select an allowance from them.

The entire 64-request experiment cost $0.3201833 in usage-derived token charges, with no unknown
reserved charges. The temporary benchmark key was revoked and its local Keychain copy removed;
displayed remaining balance was $1.66, above the $0.75 stop threshold. Production credentials and
environment values were not changed. This temporary-key access does not prove production-key
access to any newer model.

## Historical calculator and next evidence

Keep the July `snaplist-pro-model.json` and generated `snaplist-pro-results.json` as dated
assumption artifacts. They use GPT-5.5 and an embedding-per-attempt assumption; current runtime
uses Terra and default-off retrieval. Replacing historical estimates with these two easy photos
would imply unsupported durable cost precision. The existing owner decision remains provisional.

Before a future switch, evaluate representative variant/barcode/generic/voice and multi-photo
fixtures, human-grounded quality, repeated latency distributions and production-key access using
the intended preview. Measure durable successful-listing cost including retries, failures,
corrections and actual sold/web route shares before refreshing the allowance calculator.
