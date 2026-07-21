# Issue #351 voice-context primary-source research

> Retrieved: **2026-07-21**
>
> Scope: official Apple Developer and official OpenAI developer sources only.
>
> Status: research input, not an implementation authority, provider selection, UI recommendation, or production activation.

## Reading key

- **Documented fact** means the linked primary source states the behavior.
- **Source limitation** means the public source does not settle a detail, conflicts with another official page, or deliberately exposes a runtime query instead of a static answer.
- **Design inference** is a proposed consequence for issue #351. It is not a claim made by Apple or OpenAI.

## Decision summary

1. **Apple has a fully on-device path on iOS 26 and later.** `SpeechAnalyzer` coordinates analysis and `SpeechTranscriber` supplies general-purpose speech-to-text. Apple says the transcription model operates entirely on device; locale assets may first need to be downloaded from Apple and are then system-managed. The APIs were introduced in iOS 26. [Apple WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/) [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer) [Apple `AssetInventory`](https://developer.apple.com/documentation/speech/assetinventory)
2. **SnapList's iOS 17 floor requires an older-OS branch.** The repository currently targets iOS 17 (`ios/README.md` and the Xcode project), while `SpeechAnalyzer` is iOS 26+. On iOS 17-25, Apple's available speech API is `SFSpeechRecognizer`; it can remain on device only when `supportsOnDeviceRecognition` is true and the request sets `requiresOnDeviceRecognition`. Otherwise it requires a network and may use Apple servers. [Apple `supportsOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition) [Apple `requiresOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition)
3. **Availability and language support must be runtime data.** Apple exposes device capability, supported locale, installed locale, and asset status queries. A static locale or hardware table would become stale and would not prove that the needed model is installed now. [Apple `SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber) [Apple `AssetInventory.Status`](https://developer.apple.com/documentation/speech/assetinventory/status)
4. **A bounded file is the smallest cross-path seam.** Apple can recognize a recorded file (`SpeechAnalyzer`/`AVAudioFile` on iOS 26+, `SFSpeechURLRecognitionRequest` on the legacy path), and OpenAI's request API accepts uploaded WAV files. This makes a canonical 15-second file compatible with on-device Apple analysis and a provider-neutral server adapter without requiring a realtime session. [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer) [Apple `SFSpeechURLRecognitionRequest`](https://developer.apple.com/documentation/speech/sfspeechurlrecognitionrequest) [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
5. **OpenAI is a viable adapter, not an authority to hardwire.** The current file-transcription endpoint is `POST /v1/audio/transcriptions`. The official guide lists `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, and `whisper-1`. Realtime transcription uses a separate session and `gpt-realtime-whisper`; it is intended for live deltas, not required for a completed 15-second file. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) [OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription) [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
6. **Every unavailable path can honestly fail open.** Nothing in either provider contract requires voice to be present. A missing, skipped, deleted, denied, unsupported, interrupted, timed-out, or failed note can resolve to `transcript: absent` while the photo intake continues. This is a **design inference** from the optional product contract, not provider behavior.

## Disposition in ADR-0011

This report maps the viable capability space; it does not select every mapped branch. ADR-0011
selects `AVAudioRecorder` for native file capture and keeps launch transcription exclusively on the
server behind the `sellerContext` role. `SpeechAnalyzer`, `DictationTranscriber`, and
`SFSpeechRecognizer` below are evaluated alternatives, not an implementation handoff or authorized
fallback. Adding an on-device transcription adapter would require reopening the parent epic and
ADR-0011; preserving the result shape alone is not sufficient authority.

## Apple: capture and transcription primitives

### Audio capture

**Documented facts**

- `AVAudioRecorder` records audio from the active input to a file. It can record for a caller-specified duration, and `record(forDuration:)` stops when that duration is reached. `stop()` closes the file and `deleteRecording()` deletes it. [Apple `AVAudioRecorder`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder) [Apple `record(forDuration:)`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder/record%28forduration:%29)
- `AVAudioRecorder` accepts settings for Linear PCM, MPEG-4 AAC, Apple Lossless, and other encodings; Apple documents sample rates from 8 kHz through 192 kHz and 1-64 channels. [Apple `AVAudioRecorder.init(url:settings:)`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder/init%28url:settings:%29-5whyq)
- `AVAudioEngine` exposes the hardware input through its input node. A tap can observe/copy PCM buffers for recording or processing; the input node's hardware format should have a nonzero sample rate and channel count before use. [Apple `AVAudioEngine.inputNode`](https://developer.apple.com/documentation/avfaudio/avaudioengine/inputnode) [Apple `AVAudioNode`](https://developer.apple.com/documentation/avfaudio/avaudionode)
- `AVAudioConverter` can convert PCM sample representation, sample rate, channel layout, and compressed/uncompressed encodings. [Apple `AVAudioConverter`](https://developer.apple.com/documentation/avfaudio/avaudioconverter)

**Design inference**

- For a note that is recorded first and transcribed second, `AVAudioRecorder` is the smallest stable capture primitive. A live PCM tap is justified only if the implementation must transcribe during capture or share the same buffers with more than one consumer.
- Use `record(forDuration: 15)` as a user-device guard, but validate decoded duration and bytes again at every server boundary. A UI timer alone is not an authority.

### SpeechAnalyzer family (iOS 26+)

**Documented facts**

- `SpeechAnalyzer` accepts audio asynchronously, manages one analysis input sequence at a time, publishes module results through asynchronous sequences, can analyze files or buffers, and requires an explicit finish operation to terminate result streams. [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer)
- `SpeechTranscriber` is Apple's general-purpose conversation/transcription module. Call `isAvailable` for hardware/capability support and query `supportedLocales`, `installedLocales`, or `supportedLocale(equivalentTo:)` for language support. Apple explicitly suggests `DictationTranscriber` when `SpeechTranscriber` is unavailable. [Apple `SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber) [Apple `SpeechTranscriber.isAvailable`](https://developer.apple.com/documentation/speech/speechtranscriber/isavailable)
- Apple describes `DictationTranscriber` as similar to system dictation and compatible with older devices. Its `.shortDictation` preset is configured for about a minute of audio, so a 15-second note is inside that semantic class. [Apple `DictationTranscriber`](https://developer.apple.com/documentation/speech/dictationtranscriber) [Apple `shortDictation`](https://developer.apple.com/documentation/speech/dictationtranscriber/preset/shortdictation)
- The WWDC25 session says `SpeechTranscriber` is entirely on device. The model assets are fetched as needed, stored and updated by the system, and do not increase the app download or runtime memory size. [Apple WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/?time=423)
- `AssetInventory` reports `.unsupported`, `.supported`, `.downloading`, or `.installed`. An install request can return immediately when already installed; connectivity failures can cause the system to retry later. Locale asset reservations are bounded. [Apple `AssetInventory.Status`](https://developer.apple.com/documentation/speech/assetinventory/status) [Apple `assetInstallationRequest(supporting:)`](https://developer.apple.com/documentation/speech/assetinventory/assetinstallationrequest%28supporting:%29) [Apple `downloadAndInstall()`](https://developer.apple.com/documentation/speech/assetinstallationrequest/downloadandinstall%28%29)
- `bestAvailableAudioFormat(compatibleWith:)` returns the best format supported by the currently installed module assets; the correct analyzer format therefore is not a fixed app constant. [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer)
- `finalizeAndFinishThroughEndOfInput()` consumes and finalizes the ended input. `cancelAndFinishNow()` cancels pending work and finishes immediately. Analyzer errors finish the session and propagate to waiting methods/result streams. [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer) [Apple `cancelAndFinishNow()`](https://developer.apple.com/documentation/speech/speechanalyzer/cancelandfinishnow%28%29)

**Source limitations**

- Apple does not publish a durable static list of every `SpeechTranscriber` hardware/locale combination on the class page. The supported and installed locale properties are the official answer for the current device.
- `CaptureInputSequenceProvider`, `AssetInputSequenceProvider`, and `AnalyzerInputConverter` are currently labeled beta in Apple's public documentation. They are useful prototype references but are weaker authority than the stable file/buffer APIs for a production contract. [Apple Speech framework index](https://developer.apple.com/documentation/speech/) [Apple `CaptureInputSequenceProvider`](https://developer.apple.com/documentation/speech/captureinputsequenceprovider/analyzerinputs) [Apple `AnalyzerInputConverter`](https://developer.apple.com/documentation/speech/analyzerinputconverter)

### Legacy SFSpeechRecognizer branch (iOS 17-25, or explicit fallback)

**Documented facts**

- `SFSpeechURLRecognitionRequest` recognizes a prerecorded file. `SFSpeechAudioBufferRecognitionRequest` accepts live or existing PCM buffers and must receive `endAudio()` when input is complete. [Apple `SFSpeechURLRecognitionRequest`](https://developer.apple.com/documentation/speech/sfspeechurlrecognitionrequest) [Apple `SFSpeechAudioBufferRecognitionRequest`](https://developer.apple.com/documentation/speech/sfspeechaudiobufferrecognitionrequest)
- `supportsOnDeviceRecognition == false` means the recognizer requires a network. Setting `requiresOnDeviceRecognition = true` prevents network audio transmission only when that locale/device supports on-device recognition; Apple notes that this mode may be less accurate. [Apple `supportsOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition) [Apple `requiresOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition)
- Legacy recognition services may become unavailable, may enforce per-device or per-app request limits, and stop tasks longer than one minute. A 15-second cap fits the documented duration limit but does not remove availability/throttling risk. [Apple `SFSpeechRecognizer`](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- `supportedLocales()` returns locales that the recognizer knows about, but support alone does not guarantee current availability; some locales require an active network connection, and callers must also check `isAvailable`. [Apple `SFSpeechRecognizer.supportedLocales()`](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportedlocales%28%29)

**Design inference**

- Do not silently fall from an on-device request into Apple server recognition. The branch must be explicit: on-device legacy recognition, a registered provider-neutral server adapter, or `unsupported`/photos-only.
- Because this note is optional and the older API can throttle, legacy recognition should never be the gate for accepting the intake.

## Permissions and privacy gates on Apple platforms

**Documented facts**

- Microphone capture requires explicit user permission. Apple provides `AVAudioApplication.requestRecordPermission()` and requires `NSMicrophoneUsageDescription`; without the purpose string an app that accesses the microphone exits. Without permission, captured samples are silence. [Apple `AVAudioApplication.requestRecordPermission`](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission%28completionhandler:%29) [Apple `NSMicrophoneUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription)
- Apple's speech-permission article says the server-speech authorization process applies to `SFSpeechRecognizer`, and explicitly notes that `SpeechAnalyzer` transcriber modules do not send the user's voice audio to Apple servers. The legacy flow uses `SFSpeechRecognizer.requestAuthorization` and `NSSpeechRecognitionUsageDescription`. [Apple “Asking Permission to Use Speech Recognition”](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)
- Requesting speech authorization should happen only when the feature is about to be used; authorization can be denied, restricted, not determined, or authorized. [Apple “Asking Permission to Use Speech Recognition”](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)

**Source limitation**

- The same Apple permission article scopes server-speech authorization to `SFSpeechRecognizer` but also contains a broad warning that using Speech framework APIs without `NSSpeechRecognitionUsageDescription` can crash. It does not provide an equally explicit sentence saying that an app using only `SpeechAnalyzer` may omit that key. Treat this as an item to verify on minimum supported devices before removing the key; do not infer the answer from the absence of a `SpeechAnalyzer` authorization method.

**Design inference**

- Keep the two permissions separate in the capability model: microphone capture permission is always required; legacy Apple server-recognition authorization is required only when that route is actually selected. A denied or restricted permission produces `voice unavailable`, not `intake unavailable`.

## Locale behavior

**Documented facts**

- For the iOS 26 analyzer family, supported/downloadable and already-installed locales are separate runtime sets. `supportedLocale(equivalentTo:)` is the safest way to map a requested app/device locale to an Apple-supported equivalent. [Apple `SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber) [Apple `DictationTranscriber.installedLocales`](https://developer.apple.com/documentation/speech/dictationtranscriber/installedlocales)
- For legacy recognition, `supportedLocales()` is not an availability proof, and some locales need network service. [Apple `SFSpeechRecognizer.supportedLocales()`](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportedlocales%28%29)
- OpenAI publishes a language list for its speech-to-text and translation endpoints and warns that unlisted trained languages may return low-quality results. The API reference says an ISO-639-1 input language hint can improve accuracy and latency. [OpenAI supported languages](https://developers.openai.com/api/docs/guides/speech-to-text#supported-languages) [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)

**Design inference**

- Persist the user-requested BCP-47 locale and the adapter-reported resolved locale separately. Do not hardcode Apple's or OpenAI's locale inventory into the authority; resolve capabilities at request time and allow `unsupported_locale` to fail open.

## Audio format, duration, bytes, cancellation, and interruption

### Canonical bounded asset candidate

**Design inference — recommended for the issue contract, not provider fact**

| Field | Candidate authority |
|---|---|
| Container/MIME | RIFF/WAVE, `audio/wav` |
| Encoding | signed 16-bit little-endian Linear PCM |
| Sample rate/channels | 16,000 Hz, mono |
| Duration | decoded audio `0 < duration <= 15.000 s` |
| Raw PCM bytes at the duration ceiling | `16,000 samples/s * 15 s * 1 channel * 2 bytes = 480,000 bytes` |
| Encoded request ceiling | 512 KiB (`524,288` bytes), leaving bounded room for WAV metadata |

Why this is provider-neutral:

- Apple documents Linear PCM as a supported recorder format and allows 16 kHz mono. [Apple `AVAudioRecorder.init(url:settings:)`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder/init%28url:settings:%29-5whyq)
- The new analyzer can process an audio file and can dynamically choose/convert to a module-compatible analysis format; the stored file does not need to pretend its format is the analyzer's model-native format. [Apple `SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer)
- The legacy Apple file request accepts a recorded audio URL. [Apple `SFSpeechURLRecognitionRequest`](https://developer.apple.com/documentation/speech/sfspeechurlrecognitionrequest)
- OpenAI's file-transcription guide accepts WAV and has a 25 MB upload limit, so 512 KiB remains well inside the current provider ceiling without adopting that ceiling as SnapList's contract. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)

**Source limitation**

- Apple's analyzer tells callers to query the best compatible audio format at runtime. A fixed 16 kHz file format is therefore an app storage/upload choice, not a claim about the speech model's native format.
- OpenAI's guide lists `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, and `webm`, while the current API reference additionally lists `flac` and `ogg`. WAV is in the intersection, so the discrepancy does not affect this candidate. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)

### Cancellation and interruption

**Documented facts**

- `AVAudioRecorder.stop()` stops and closes the current file; `deleteRecording()` deletes it. `SpeechAnalyzer.cancelAndFinishNow()` cancels pending analysis and finishes immediately. [Apple `AVAudioRecorder`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder) [Apple `cancelAndFinishNow()`](https://developer.apple.com/documentation/speech/speechanalyzer/cancelandfinishnow%28%29)
- `AVAudioSession.interruptionNotification` reports when an interruption begins and the session becomes inactive. Apple documents observing interruption begin/end rather than assuming continuous capture. [Apple `interruptionNotification`](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification) [Apple “Handling audio interruptions”](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)
- Audio routes can change when an input/output is connected or removed; Apple exposes `routeChangeNotification` and reasons such as `.oldDeviceUnavailable`. [Apple “Responding to audio route changes”](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)

**Design inference**

- User cancel/delete: stop capture, cancel analysis/upload tasks, delete the local file, clear its digest/version, and proceed as if voice was never supplied.
- User stop or 15-second auto-stop: close the file, validate duration/bytes, then start transcription.
- Interruption, route loss, suspension, encoder error, or zero/silent capture: do not auto-resume and do not silently use a partial transcript. Mark the voice attempt unavailable, delete the partial file, and continue photos-only. A later explicit retry is a new voice asset version.
- Provider timeout/cancellation: cancel the adapter request and return a typed absent result; the capture/pipeline caller must not wait indefinitely or interpret cancellation as an item-run failure.

## OpenAI transcription: current official surface

### Models and endpoints

**Documented facts**

- `POST /v1/audio/transcriptions` is the bounded file/request endpoint. Current supported model IDs in the guide/reference are `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, and `whisper-1`; the reference also exposes the dated mini snapshot `gpt-4o-mini-transcribe-2025-12-15`. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` accept audio/text input and return text. OpenAI describes both as more accurate and better at language recognition than original Whisper models. [OpenAI `gpt-4o-transcribe`](https://developers.openai.com/api/docs/models/gpt-4o-transcribe) [OpenAI `gpt-4o-mini-transcribe`](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- `whisper-1` supports transcription and translation. The translations endpoint translates only into English and supports only `whisper-1`; translation is a different operation from preserving the note's original language. [OpenAI `whisper-1`](https://developers.openai.com/api/docs/models/whisper-1) [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text#translations)
- `gpt-4o-transcribe-diarize` adds speaker labels. For audio longer than 30 seconds it requires a chunking strategy. A single-speaker, at-most-15-second note does not require diarization. The last sentence is a **design inference**. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text#speaker-diarization)
- Realtime transcription uses a transcription session and `gpt-realtime-whisper`, which accepts streaming audio and emits deltas. OpenAI directs offline files and non-streaming workflows to the standard Audio API. [OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)

### File and request constraints

**Documented facts**

- The guide's current upload limit is 25 MB. It tells callers to split or compress larger inputs; a 15-second/512-KiB SnapList asset does not approach that provider limit. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text#longer-inputs)
- The request is multipart form data and takes an audio file object plus a model ID. An optional ISO-639-1 language can improve accuracy and latency. [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- Completed audio files can return a normal response or stream transcription events for supported models. `whisper-1` does not support streamed transcription. [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text#streaming-the-transcription-of-a-completed-audio-recording)

**Source limitation**

- The guide and API reference currently disagree on some response-format details for GPT-4o transcription. The provider-neutral SnapList seam only needs normalized text plus provider metadata; adapter contract tests should follow the live SDK/OpenAPI schema for the selected model rather than encode the guide disagreement into the domain.

### Pricing

**Documented facts as of retrieval**

| Model | Official estimated transcription price | 15-second arithmetic estimate |
|---|---:|---:|
| `gpt-4o-mini-transcribe` | $0.003/minute | $0.00075 |
| `gpt-4o-transcribe` | $0.006/minute | $0.00150 |
| `gpt-realtime-whisper` | $0.017/minute | $0.00425 |

The current pricing page labels the first two as transcription prices and the realtime model separately. The 15-second column is simple proportional arithmetic (`price * 0.25`), not an OpenAI quote, minimum-charge promise, or measured SnapList cost. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

**Source limitation**

- The current pricing page does not surface a `whisper-1` row in the transcription section found during this retrieval. Do not reuse an older remembered Whisper price as current authority.
- Pricing is mutable. A production adapter must take cost metadata/configuration from a current operator-controlled source rather than hardcode this research snapshot.

### Latency

**Documented facts**

- OpenAI distinguishes request/file transcription from realtime transcription. Realtime `gpt-realtime-whisper` exposes qualitative delay levels; OpenAI says the exact millisecond delay varies and must be benchmarked with representative microphones, accents, noise, languages, and vocabulary. [OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription#tune-latency-and-accuracy)
- For the file endpoint, the API reference says an accurate language hint can improve latency, and the guide permits streaming deltas from a completed recording for supported models. [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text#streaming-the-transcription-of-a-completed-audio-recording)

**Source limitation**

- The official file-transcription pages publish no fixed p50/p95 latency or completion SLA for a 15-second upload. Model selection cannot be frozen from official latency claims alone; the issue's throwaway prototype must measure representative files and keep a timeout/fail-open path.

### Privacy, training, and retention

**Documented facts as of retrieval**

- OpenAI's endpoint retention table marks `/v1/audio/transcriptions` as: data used for training **No**; abuse-monitoring retention **None**; application-state retention **None**; Zero Data Retention eligible **Yes**; Eyes Off/Safety Retention eligible **No**. [OpenAI “Storage requirements and retention controls per endpoint”](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint)
- Data residency/processing availability is organization/region dependent. The current data-controls guide lists audio transcription among region-supported endpoints, with different storage/processing capabilities and MAM/ZDR requirements by region. [OpenAI data residency controls](https://developers.openai.com/api/docs/guides/your-data#which-models-and-features-are-eligible-for-data-residency)

**Source limitations**

- OpenAI's endpoint table describes OpenAI platform handling, not SnapList's own local, object-storage, log, backup, or transcript retention. SnapList still needs an explicit raw-audio deletion and account/item deletion contract.
- Public docs describe service behavior, not a substitute for the applicable contract/DPA, selected regional endpoint, or operator account controls at activation time.

## Provider-neutral design consequences

The following are **design inferences for issue #351**, deliberately independent of an Apple/OpenAI default:

1. The capture layer produces either no voice asset or one validated `VoiceAsset` with canonical bytes, duration, MIME/codec, locale hint, digest, and monotonically changing asset version.
2. The transcription role consumes that neutral asset and returns one of:
   - `transcribed(text, resolvedLocale, adapterMetadata)`;
   - `absent(reason)` for skipped/deleted/denied/unsupported/interrupted/timed-out/failed;
   - `invalid(reason)` for a duration/byte/format contract violation.
3. Apple on-device analysis is a researched future alternative. The accepted launch contract keeps
   transcription on the server behind a separately registered provider-neutral adapter. Capture and
   pipeline callers never construct a provider.
4. The photo-set fingerprint remains the immutable AI-item identity. Voice `version + digest` participates in request idempotency so changing/deleting/re-recording voice cannot replay as the same request.
5. A transcript is unverified seller context. It may help generate copy or condition notes but cannot override image evidence, catalog identity, sold-price evidence, marketplace state, or seller-confirmed edits without an explicit conflict/review rule.
6. Raw audio should be locally encrypted while it is part of recoverable intake. Server-side raw bytes should exist only for the bounded transcription/retry window and be deleted when transcription reaches a terminal result; the normalized transcript may follow the owning draft/item lifecycle and must be included in item/account deletion. Exact timings are product/privacy authority to freeze in the ADR, not facts supplied by Apple or OpenAI.
7. `absent` is a successful optional-voice outcome. The listing pipeline always accepts the same photo input without a transcript.

## Researched capability matrix (not selected launch implementation)

This matrix records how each evaluated path would fail open. ADR-0011 selects only microphone/file
capture on native and the bounded server-adapter row for launch.

| Gate | Documented probe | Expected issue behavior |
|---|---|---|
| Microphone permission | `AVAudioApplication.requestRecordPermission()` | Denied/restricted -> voice absent; photos continue |
| iOS 26+ primary module | `SpeechTranscriber.isAvailable` | False -> try a separately authorized fallback or voice absent |
| Apple locale | `supportedLocale(equivalentTo:)` | Nil -> fallback/absent; never substitute an unrelated locale |
| Apple asset | `AssetInventory.status(forModules:)` | Installed -> analyze; supported/downloading -> bounded install decision; unsupported/failure -> fallback/absent |
| iOS 26+ older-device module | `DictationTranscriber` support/locale | Use only when runtime-supported; otherwise absent |
| iOS 17-25 legacy on-device | `supportsOnDeviceRecognition` plus `requiresOnDeviceRecognition = true` | Unsupported -> do not silently send to Apple servers |
| Legacy Apple server path | speech authorization + `isAvailable` + network/service limits | Any denial/unavailability/throttle -> fallback/absent |
| File contract | decoded duration, WAV structure, 512-KiB ceiling, nonempty audio | Invalid -> typed invalid/absent; photos continue |
| Interruption/route loss | audio-session notifications | cancel, delete partial asset, photos continue |
| Server adapter | bounded timeout/cancellation and normalized result | timeout/error -> absent; no pipeline failure |
| User delete/re-record | voice version + digest | delete clears context; re-record creates a new idempotency input |

## Primary-source index

### Apple

- [Speech framework](https://developer.apple.com/documentation/speech/)
- [`SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer)
- [`SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber)
- [`DictationTranscriber`](https://developer.apple.com/documentation/speech/dictationtranscriber)
- [`AssetInventory`](https://developer.apple.com/documentation/speech/assetinventory)
- [WWDC25: Bring advanced speech-to-text to your app with SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/)
- [Asking Permission to Use Speech Recognition](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)
- [`AVAudioRecorder`](https://developer.apple.com/documentation/avfaudio/avaudiorecorder)
- [`AVAudioApplication.requestRecordPermission`](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission%28completionhandler:%29)
- [Handling audio interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)
- [Responding to audio route changes](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)

### OpenAI

- [Speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Create transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-4o Transcribe model](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)
- [GPT-4o mini Transcribe model](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- [Whisper model](https://developers.openai.com/api/docs/models/whisper-1)
- [Data controls and retention](https://developers.openai.com/api/docs/guides/your-data)
