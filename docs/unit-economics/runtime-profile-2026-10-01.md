# Approved runtime model profile — October 1, 2026

The owner approved a lower-cost Luna generation profile after the original
[screening](../benchmarks/model-generations/2026-10-01/REPORT.md). Model defaults and
OpenAI effort injection live in `src/lib/llm/registry.ts`; no call site constructs a provider.

| Role | OpenAI default | Effort | Model rollback variable | Effort rollback variable |
|---|---|---|---|---|
| Vision | gpt-6-luna | low | VISION_MODEL | VISION_REASONING_EFFORT |
| Listing | gpt-6-luna | none | LISTING_MODEL | LISTING_REASONING_EFFORT |
| Export | gpt-6-luna | none | EXPORT_PACK_MODEL | EXPORT_PACK_REASONING_EFFORT |
| Pricing extraction/fallback | gpt-6-luna | low | PRICING_MODEL | PRICING_REASONING_EFFORT |
| OpenAI offline judge (unchanged) | gpt-5.6-terra | provider default | EVAL_JUDGE_MODEL | n/a |
| Recorded seller voice | gpt-transcribe | n/a | SELLER_CONTEXT_TRANSCRIPTION_MODEL | n/a |

The judge still selects the opposite provider from generation. OpenAI generation
therefore uses the unchanged Google judge; Google generation keeps the Terra judge. The judge model, request path and
effective effort stay unchanged; no live judge calls are part of this switch.
Google defaults, media fences, transcription activation, the 20-second voice
deadline, photos-only failure handling and default-off retrieval stay intact.
Embeddings remain text-embedding-3-small with the 1536-dimensional storage contract.

Effort settings apply only to OpenAI. Supported values are the installed SDK's
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`; `default` omits effort entirely.
Choose an effort supported by the overridden model. To restore the previous profile,
set each runtime generation model to gpt-5.6-terra and its effort to
`default`; set voice to gpt-4o-mini-transcribe. Model and effort are independent.

## Verified API contracts

OpenAI Developer Docs MCP confirmed [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[completed-file transcription](https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe).
The existing SDK Chat Completions path sends `reasoning_effort` through the SDK's
`providerOptions.openai.reasoningEffort`. Structured output remains generateObject + Zod.
No tool calling is used on these paths.

Recorded WAVs use POST /v1/audio/transcriptions with multipart `model` and `file`.
The caller sends no legacy language, timestamp or response-format options; the
endpoint's JSON default is consumed by the installed SDK. Empty detected-language
arrays are valid; transcript text drives the existing bounded normalization.

## Economics and rollout evidence

Luna Standard short-context rates are $0.10/M input, $0.01/M cached input and
$0.50/M output versus Terra's $2/$0.20/$12. The original two-photo Luna sample
cost $0.000572 per schema-valid complete candidate versus $0.009331 for Terra.
Those calls omitted effort and exclude durability, voice, export, sold/web fees,
failures and corrections; they do not predict the new profile's subscriber COGS.
GPT-Transcribe costs $0.0045/minute (at most $0.001125 for a 15-second note),
versus mini-transcribe's $0.003/minute. The dated July allowance calculator stays intact.

Vercel production was inspected before the switch: none of VISION_MODEL,
LISTING_MODEL, EXPORT_PACK_MODEL, PRICING_MODEL, EVAL_JUDGE_MODEL,
SELLER_CONTEXT_TRANSCRIPTION_MODEL or the effort variables above is set.
There are no pinned old values to update after merge. No production configuration
or secret value was changed. Rollback requires an explicit deployment with the overrides.

The PR body is the authoritative rollout receipt. OPENAI_API_KEY is scoped only
to Production, so Preview cannot exercise the real key; sensitive values are empty
in the CLI env pull and cannot provide local access proof. Firstmate approved the
alternative: after merge/deploy, run one hosted photos-plus-voice listing smoke
with the real production runtime credentials and record success and total time.
Use an authenticated test account and POST /v1/items/runs (multipart photo,
voiceContext WAV, voiceContextLocale), then poll GET /v1/runs/{runId} to durable
completion and inspect the editable item/listing. The route wakes the existing
protected pipeline worker. Do not publish to a marketplace. A failed stage uses
the rollback overrides above and a redeploy.
The worker does not merge or touch a physical phone. Full quality distributions
and durable cost telemetry remain future evidence, not claims from one smoke.
