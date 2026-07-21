# ADR-0011 — Optional short seller voice context

- **Status:** Accepted (2026-07-21)
- **Decider:** Aziz
- **Owned by:** issue #351
- **Parent:** issue #349
- **Coordinates with:** issue #350 (lean-MVP product authority) and issue #352 (photo-count contract)
- **Related authority:** ADR-0002, ADR-0007, ADR-0008, and ADR-0009

## Context

The lean Scan-to-Trophy-Wall intake needs a zero-keyboard way for a seller to add a small amount of
context, such as “scratch on the back” or “charger is included.” Voice must remain optional and must
not become a second capture product, a conversational assistant, or a source of verified item truth.
The seller must still get a photos-only listing when recording or transcription is unavailable.

SnapList currently targets iOS 17. Its native capture store already uses complete file protection,
excludes recoverable intake from backup, and applies a 24-hour local recovery window. The server
keeps immutable AI-item identity in an order-independent verified photo-set fingerprint while a
separate request fingerprint binds exact request-affecting input to an idempotency key. The durable
pipeline is server-executed and role-keyed provider construction is centralized.

Apple now offers two materially different speech paths:

- `AVAudioRecorder` in AVFAudio records a bounded file and supports a fixed recording duration. It
  is available on SnapList's iOS 17 floor and is sufficient for this simple file-capture need.
- `SpeechAnalyzer` and `SpeechTranscriber` provide private on-device transcription beginning on
  iOS 26, with downloadable locale assets and device/locale availability checks. The legacy
  `SFSpeechRecognizer` path covers older OS versions but can require Apple's servers and a separate
  speech-recognition permission.

The current OpenAI transcription API is a viable hosted adapter, accepts bounded WAV uploads, and is
supported by Vercel AI SDK's experimental transcription model seam. It also introduces direct cost
and an external data-processing boundary. Model ids, pricing, retention controls, and endpoint
constraints can change, so none belongs in the product contract.

Primary-source findings and the selection evidence are recorded in
`docs/research/issue-351-voice-context-primary-sources.md`. The executable authority matrix lives in
`docs/contracts/voice-context-v1.json`.

## Decision

### 1. Voice is one optional intake asset

An intake has either no voice asset or exactly one `voice_context_v1` asset. The seller may skip it,
stop early, replace it before submission, or delete it. None of those actions requires a keyboard or
changes whether the photos can be submitted.

Voice is not a command interface, dictation editor, conversation, navigation mechanism, barcode
mode, or additional AI-item. It has no independent lifecycle after the item intake.

### 2. Capture with AVAudioRecorder; fail open to no voice

The native capture primitive is `AVAudioRecorder` under AVFAudio, configured with the record audio
session category. `AVAudioEngine` is not justified because SnapList does not need live effects,
buffer processing, mixing, or a parallel streaming transcription experience.

The app requests microphone permission only after the seller intentionally starts the optional
voice action. It uses `AVAudioApplication` on the supported iOS floor and declares an honest
microphone usage description. Permission denial or restriction, no input route, interruption,
backgrounding, encoder failure, cancellation, or a missing asset returns a no-voice intake without
altering the photos. SnapList does not substitute a mandatory text field or silently start a second
recognizer.

The recorder hard-stops at 15,000 milliseconds by using the duration-bounded recording API. The
accepted wire format is:

- RIFF/WAVE container (`audio/wav`);
- signed 16-bit little-endian Linear PCM;
- mono, 16 kHz;
- at most 15,000 milliseconds after decoding; and
- at most 512 KiB, including RIFF metadata (15 seconds of canonical PCM is 480,000 bytes before
  headers).

The server treats declared media type, duration, and byte length as untrusted. It verifies the
RIFF/WAVE structure, derives duration from validated frame data, enforces both limits, and computes
SHA-256 over the exact accepted bytes. The multipart parser caps and discards an oversized or invalid
voice part without buffering beyond the contract ceiling. Invalid voice becomes absent in the
logical request and produces the photos-only path; it never invalidates otherwise-valid photos.

Voice travels in the same `POST /v1/items/runs` multipart mutation and under the same
`Idempotency-Key` as the photos. There is no separate audio upload, signed URL, reservation, or run.
The optional file field is `voiceContext`; it may occur at most once. The optional
`voiceContextLocale` field is a BCP-47 hint and is ignored when missing, invalid, or unaccompanied by
an accepted voice file. Clients do not supply duration, byte length, digest, codec, or voice version;
the server derives them from the accepted bytes under V1.

The submission receipt adds a required-nullable `voiceContext` field. `null` means no voice bytes
were durably accepted, including invalid/oversized input. An accepted receipt is exactly
`{ version: 1, contentSha256, byteLength, durationMs, mediaType: "audio/wav" }`. Local cleanup may
remove voice bytes after canonical durable acceptance only when this receipt matches the staged
asset. Queue messages remain the strict identifier-only ADR-0007 envelope and never carry audio.

### 3. Keep launch transcription on the server boundary

`SpeechAnalyzer` is the strongest Apple transcription primitive evaluated for iOS 26 devices, but it
is not a selected SnapList adapter. SnapList still supports iOS 17 and the parent epic keeps
transcription in the server-executed pipeline. The legacy `SFSpeechRecognizer` is also not used as an
older-device fallback: it can create a separate Apple-server data boundary and inconsistent
locale/connectivity behavior.

The honest native fallback is capture without local transcription. A future issue may add an
iOS-26 on-device adapter only after Aziz explicitly reopens the server-only parent/ADR boundary.
Preserving this ADR's result shape alone does not authorize a second transcript source.

### 4. Add a provider-neutral transcription role, not a generation role

The server role is `sellerContext`. It is resolved through a dedicated transcription-model resolver
beside the existing role-keyed model registry. It is not added to `LlmRole`: generation models and
transcription models have different SDK types and call contracts.

The stable domain seam is:

```ts
type SellerContextTranscriptionResult =
  | { kind: "transcribed"; text: string; language: string | null }
  | { kind: "empty" | "unsupported" | "timed-out" | "failed" };

interface SellerContextTranscriber {
  transcribe(input: {
    bytes: Uint8Array;
    mediaType: "audio/wav";
    contentSha256: string;
    durationMs: number;
    localeHint: string | null;
    signal: AbortSignal;
  }): Promise<SellerContextTranscriptionResult>;
}
```

Capture and pipeline callers receive this interface. They do not import a provider SDK, construct a
model, name a model id, or send provider-specific options. A provider adapter may use Vercel AI SDK
internally, but the experimental SDK surface does not escape the adapter.

Transcription is disabled by default. Enabling any hosted adapter is an operator-controlled config
decision that requires current model-id verification, a live price/latency check, privacy disclosure,
credentials, and focused contract evidence. This ADR does not select or activate a production model.

### 5. Bind voice to request replay, never to AI-item identity

The immutable AI-item identity remains `content_sha256_set_v1`, derived only from the verified photo
set. Voice presence, deletion, replacement, transcript text, provider, model, language, or failure
cannot change the photo-set fingerprint, credit identity, or guided-correction eligibility.

The next mobile request-fingerprint version includes:

- the existing ordered photo bytes/digests and other request-affecting fields;
- `voice: null` when the intake has no voice asset; or
- `voice: { version, contentSha256, byteLength, durationMs, mediaType }` for the exact accepted voice
  asset.

The transcript is output and is never included in the request fingerprint. An exact replay of the
same idempotency key and request fingerprint returns the original durable result. Reusing that key
after adding, replacing, or deleting voice is a conflict, not a replay. Before any server acceptance,
the local draft may change while retaining its unsent logical key; after an ambiguous submission,
the intake must preserve the original bytes and key until canonical server truth resolves.

### 6. Every non-transcribed outcome continues photos-only

The normalized outcomes are `transcribed`, `invalid`, `empty`, `unsupported`, `timed-out`, and `failed`.
Missing, skipped, deleted, permission-denied, interrupted, and canceled capture never create a server
voice asset and therefore enter the same photos-only path.

Transcription has a 20-second attempt deadline and at most one billable attempt per logical run. The
worker durably marks the attempt before an external call. An ambiguous response therefore loses the
optional voice context rather than risking duplicate spend on queue redelivery. Transcription never
creates a second run, reserves another credit, changes allowance settlement, or makes the durable
pipeline terminally fail.

A successful transcript is normalized to Unicode plain text, trimmed, stripped of control
characters, and bounded to both 1,000 Unicode scalar values and 4 KiB UTF-8. Empty output is
photos-only. Provider errors normalize to the bounded outcome enum. Raw provider messages, response
bodies, audio, transcript fragments, and provider request ids are never persisted as telemetry.
Per-run telemetry may retain only adapter/model configuration ids, outcome, elapsed milliseconds,
billed audio seconds, and measured/estimated cost; it follows item/account deletion. Deidentified
aggregate cost/latency measurements may persist without seller, item, run, audio, transcript, or
provider request identity.

### 7. A transcript is seller context, not verified truth

The seller owns the retained transcript as part of the item. SnapList labels its provenance as
`seller_voice` and treats it as unverified input. It may:

- add an explicitly seller-stated condition note;
- help phrase editable title or description copy; or
- prompt review when it conflicts with stronger evidence.

It cannot silently replace image- or catalog-derived identity, become a sold comp, affect pricing
evidence, increase composite confidence, authorize marketplace state, override confirmed eBay
truth, or introduce a factual claim without seller-visible qualification. The transcript is data,
not instructions to the listing model; implementations delimit it as untrusted content and never
execute embedded prompt text.

### 8. Raw audio is temporary; transcript retention follows the item

Local voice bytes use the same Application Support directory, backup exclusion, complete file
protection, and 24-hour recovery ceiling as the intake's photos. They are removed when the seller
deletes voice, discards the intake, canonical durable acceptance permits local cleanup, or the local
recovery window expires.

Server raw audio is private temporary processing input. It is deleted after the first durable
terminal transcription outcome (`transcribed`, `empty`, `unsupported`, `timed-out`, or `failed`) and
in every case no later than 24 hours after durable acceptance. Cleanup must be durable and retryable;
a failed delete cannot be reported as deleted. Raw audio is never copied into the item, listing,
prediction log, evaluation corpus, analytics, or marketplace payload.

The bounded transcript, provenance, and optional language tag may persist with the item. Guest claim
transfers it with the same item; guest expiry deletes it. Deleting the voice context, item, or account
deletes the retained transcript under the existing deletion authority. No provider-specific request
id or raw response becomes seller content.

A hosted provider may independently retain request content under its then-current API data policy.
That external policy cannot be described as SnapList deletion. Provider activation is blocked until
the operator verifies and discloses the current default retention and any approved zero-retention
controls. With transcription disabled, SnapList incurs no hosted transcription cost or external
audio disclosure.

## Contract evidence and finite implementation handoff

`docs/contracts/voice-context-v1.json` is the machine-readable decision record. Its contract test
proves:

- exact duration, byte, format, transcript, role, deadline, and attempt limits;
- voice does not enter photo identity but does enter request idempotency;
- missing, skipped, deleted, permission-denied, interrupted, invalid, empty, unsupported, timed-out,
  and failed outcomes all continue with photos and no seller context;
- only a bounded `transcribed` outcome supplies unverified seller context; and
- raw-audio and transcript deletion boundaries remain distinct.

Future implementation is finite and separately issue-owned:

1. extend the recoverable native intake bundle with one protected `voice_context_v1` asset and the
   permission/interruption state machine;
2. version the mobile multipart/OpenAPI request and request fingerprint without changing photo-set
   identity;
3. add private raw-audio staging plus durable terminal cleanup, without putting audio in the queue;
4. add the `sellerContext` resolver/adapter and fail-open orchestration checkpoint;
5. persist the bounded transcript as seller-owned unverified context and enforce its generation
   authority; and
6. prove exact replay, changed-voice conflict, at-most-one external attempt, all photos-only
   outcomes, tenant isolation, guest claim/expiry, and deletion cleanup.

This issue ships no UI, microphone permission string, Swift implementation, API change, migration,
pipeline change, credential, hosted resource, provider activation, or production data mutation.

Issue #350 owns the exact PRD, AGENTS, and `CONTEXT.md` lean-MVP composition and has already recorded
the ubiquitous product term **voice context**. This branch does not duplicate those files. Internal
contract identifiers such as `voice_context_v1`, `sellerContext`, and `seller_voice` remain in this
ADR/contract rather than being promoted to product glossary terms.

## Alternatives considered

- **Make voice mandatory or add a keyboard fallback** — rejected: the approved value is optional
  zero-keyboard context and photos must remain sufficient.
- **Use AVAudioEngine and stream live audio** — rejected: it creates unnecessary buffering,
  interruption, and lifecycle complexity for one 15-second file.
- **Use SpeechAnalyzer as the only launch transcriber** — rejected for now: it would raise the iOS
  floor from 17 to 26 or create different transcript paths by device.
- **Fall back to SFSpeechRecognizer on older devices** — rejected: it can require Apple's servers,
  another permission, and locale/connectivity behavior outside the single server boundary.
- **Construct OpenAI directly in the pipeline** — rejected: it would hardwire provider, model,
  pricing, data policy, and SDK behavior at a domain call site.
- **Include transcript text in AI-item identity** — rejected: nondeterministic output would corrupt
  photo-based accounting and correction authority.
- **Retain raw audio with the listing** — rejected: the transcript is sufficient seller context and
  raw voice is more sensitive, more expensive, and not marketplace truth.

## Consequences

- Sellers can add short spoken context without making voice a prerequisite.
- iOS 17 remains supported, and the native capture primitive is simple and availability-honest.
- Provider selection, model ids, pricing, and privacy controls can change behind one stable role.
- Optional voice never changes photo-set identity or consumes a second AI-item credit.
- At-most-one external attempt deliberately favors bounded cost and privacy over recovering an
  ambiguous optional transcript.
- The server must add explicit raw-audio cleanup and transcript provenance before provider
  activation; a generic photo or model-output field is not an acceptable shortcut.
