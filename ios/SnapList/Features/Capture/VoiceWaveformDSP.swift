import Accelerate
import Foundation

/// One analysis window's measurements. Everything the meter draws is derived
/// from these three numbers, so they are the seam the tests drive.
struct VoiceWaveformFrame: Equatable, Sendable {
    /// Linear RMS of the window, `0...1` for normalized PCM.
    let rootMeanSquare: Float
    /// `rootMeanSquare` in dBFS, floored at ``VoiceWaveformAnalyzer/silenceDecibels``.
    let decibels: Float
    /// Normalized spectral centroid, `0` at DC and `1` at Nyquist. A vowel sits
    /// near the bottom of the range; an "s" sits near the top.
    let brightness: Float
}

/// Turns a window of PCM into a ``VoiceWaveformFrame``.
///
/// Deliberately not an FFT. The meter needs one scalar per window, not a
/// spectrum, and for any signal the first difference gives the energy-weighted
/// centroid in closed form: `RMS(x[n] − x[n−1]) = 2·sin(π·f̄/fs)·RMS(x)`, so
/// `f̄/nyquist = (2/π)·asin(ratio)`. That is exact for a tone, well behaved for
/// broadband input, and two `vDSP` passes instead of a windowed transform plus a
/// cached setup object on a ~48 Hz hot path.
enum VoiceWaveformAnalyzer {
    /// The dBFS value reported for digital silence. `log10(0)` is not a number,
    /// and callers need an orderable floor rather than `-infinity`.
    static let silenceDecibels: Float = -80

    static func analyze(_ samples: [Float], sampleRate: Double) -> VoiceWaveformFrame {
        guard !samples.isEmpty else {
            return VoiceWaveformFrame(
                rootMeanSquare: 0,
                decibels: silenceDecibels,
                brightness: 0
            )
        }

        let rootMeanSquare = vDSP.rootMeanSquare(samples)
        guard rootMeanSquare > 0, rootMeanSquare.isFinite else {
            return VoiceWaveformFrame(
                rootMeanSquare: 0,
                decibels: silenceDecibels,
                brightness: 0
            )
        }

        let decibels = max(20 * log10(rootMeanSquare), silenceDecibels)
        return VoiceWaveformFrame(
            rootMeanSquare: rootMeanSquare,
            decibels: decibels,
            brightness: brightness(
                of: samples,
                rootMeanSquare: rootMeanSquare,
                sampleRate: sampleRate
            )
        )
    }

    private static func brightness(
        of samples: [Float],
        rootMeanSquare: Float,
        sampleRate: Double
    ) -> Float {
        guard samples.count >= 2, sampleRate > 0 else {
            return 0
        }
        var difference = [Float](repeating: 0, count: samples.count - 1)
        vDSP.subtract(
            samples[1...],
            samples[..<(samples.count - 1)],
            result: &difference
        )
        let differenceRootMeanSquare = vDSP.rootMeanSquare(difference)
        guard differenceRootMeanSquare.isFinite else {
            return 0
        }
        let ratio = min(
            max(differenceRootMeanSquare / (2 * rootMeanSquare), 0),
            1
        )
        return Float(2 / Double.pi * asin(Double(ratio)))
    }
}

/// The live meter's envelope: an adaptive noise floor, a decibel-domain range
/// map, optional spectral-brightness weighting, and asymmetric attack/release.
///
/// A value type with no dependencies beyond arithmetic, so a test can settle one
/// on room tone and then branch it per utterance. Every time constant is stated
/// in seconds and converted against the caller's frame duration, so the
/// engine-tap rate and the recorder-meter fallback rate produce the same curve.
struct VoiceMeterEnvelope {
    struct Tuning: Equatable, Sendable {
        /// Where the tracked floor starts before any audio has arrived.
        var initialNoiseFloorDecibels: Float
        /// The quietest floor the tracker will report. Below this the mapping
        /// starts amplifying converter noise into visible bars.
        var noiseFloorLimitDecibels: Float
        /// The loudest floor the tracker will report. A room this loud is
        /// already unusable; letting the floor chase it further would hide
        /// speech entirely.
        var noiseFloorCeilingDecibels: Float
        /// Width of one minimum-tracking subwindow.
        var noiseFloorSubwindowSeconds: TimeInterval
        /// Time constant for following the observed minimum downward.
        var noiseFloorFallSeconds: TimeInterval
        /// Ceiling on how fast the floor may climb. Speech pauses inside the
        /// tracking window are what keep sustained talking from raising it.
        var noiseFloorRiseDecibelsPerSecond: Float
        /// Dead band above the floor. Nothing inside it is drawn, so a pause
        /// reads as a pause instead of as low-level shimmer.
        var guardBandDecibels: Float
        /// Decibels above the guard band mapped onto the full bar height.
        var spanDecibels: Float
        /// Sub-unity exponent, so quiet speech gains more height per decibel
        /// than loud speech does. This is what separates the soft end.
        var contourExponent: Float
        var attackSeconds: TimeInterval
        var releaseSeconds: TimeInterval
        /// How much normalized brightness shifts bar height. `0` disables it.
        var brightnessWeight: Float
        /// The brightness treated as neutral; a vowel sits below it, a
        /// fricative above.
        var brightnessPivot: Float

        init(
            initialNoiseFloorDecibels: Float = -55,
            noiseFloorLimitDecibels: Float = -75,
            noiseFloorCeilingDecibels: Float = -28,
            noiseFloorSubwindowSeconds: TimeInterval = 0.5,
            noiseFloorFallSeconds: TimeInterval = 0.05,
            noiseFloorRiseDecibelsPerSecond: Float = 2,
            guardBandDecibels: Float = 6,
            spanDecibels: Float = 34,
            contourExponent: Float = 0.72,
            attackSeconds: TimeInterval = 0.035,
            releaseSeconds: TimeInterval = 0.22,
            brightnessWeight: Float = 0.35,
            brightnessPivot: Float = 0.3
        ) {
            self.initialNoiseFloorDecibels = initialNoiseFloorDecibels
            self.noiseFloorLimitDecibels = noiseFloorLimitDecibels
            self.noiseFloorCeilingDecibels = noiseFloorCeilingDecibels
            self.noiseFloorSubwindowSeconds = noiseFloorSubwindowSeconds
            self.noiseFloorFallSeconds = noiseFloorFallSeconds
            self.noiseFloorRiseDecibelsPerSecond = noiseFloorRiseDecibelsPerSecond
            self.guardBandDecibels = guardBandDecibels
            self.spanDecibels = spanDecibels
            self.contourExponent = contourExponent
            self.attackSeconds = attackSeconds
            self.releaseSeconds = releaseSeconds
            self.brightnessWeight = brightnessWeight
            self.brightnessPivot = brightnessPivot
        }
    }

    /// The tap's nominal cadence: 1024 frames of 48 kHz hardware input.
    static let nominalFrameDuration: TimeInterval = 1024.0 / 48_000.0

    /// Three subwindows of half a second: long enough that sustained room tone
    /// pins the minimum, short enough that the gap between two words does too.
    private static let subwindowCount = 3

    let tuning: Tuning
    private(set) var noiseFloorDecibels: Float
    private(set) var level: Double = 0

    private var completedSubwindowMinima: [Float]
    private var currentSubwindowMinimum: Float = .greatestFiniteMagnitude
    private var currentSubwindowElapsed: TimeInterval = 0

    init(tuning: Tuning = Tuning()) {
        self.tuning = tuning
        noiseFloorDecibels = tuning.initialNoiseFloorDecibels
        completedSubwindowMinima = Array(
            repeating: tuning.initialNoiseFloorDecibels,
            count: Self.subwindowCount
        )
    }

    mutating func reset() {
        self = VoiceMeterEnvelope(tuning: tuning)
    }

    @discardableResult
    mutating func ingest(
        _ frame: VoiceWaveformFrame,
        frameDuration: TimeInterval = VoiceMeterEnvelope.nominalFrameDuration
    ) -> Double {
        let step = max(frameDuration, 0.001)
        trackNoiseFloor(frame.decibels, step: step)

        let threshold = noiseFloorDecibels + tuning.guardBandDecibels
        let span = max(tuning.spanDecibels, 1)
        let normalized = min(max((frame.decibels - threshold) / span, 0), 1)
        var target = pow(normalized, tuning.contourExponent)
        target *= 1 + tuning.brightnessWeight
            * (frame.brightness - tuning.brightnessPivot)
        target = min(max(target, 0), 1)

        let coefficient = Double(target) > level
            ? Self.coefficient(step: step, timeConstant: tuning.attackSeconds)
            : Self.coefficient(step: step, timeConstant: tuning.releaseSeconds)
        level = min(max(level + (Double(target) - level) * coefficient, 0), 1)
        return level
    }

    /// Minimum statistics: the floor is the smallest level seen across the last
    /// few subwindows, followed quickly downward and rate-limited upward. An
    /// exponential average cannot do this job — it cannot tell sustained room
    /// tone from sustained speech, because the only difference between them is
    /// that speech has gaps.
    private mutating func trackNoiseFloor(_ decibels: Float, step: TimeInterval) {
        currentSubwindowMinimum = min(currentSubwindowMinimum, decibels)
        currentSubwindowElapsed += step
        if currentSubwindowElapsed >= tuning.noiseFloorSubwindowSeconds {
            completedSubwindowMinima.removeFirst()
            completedSubwindowMinima.append(currentSubwindowMinimum)
            currentSubwindowMinimum = decibels
            currentSubwindowElapsed = 0
        }

        let observed = min(
            currentSubwindowMinimum,
            completedSubwindowMinima.min() ?? currentSubwindowMinimum
        )

        if observed < noiseFloorDecibels {
            let coefficient = Self.coefficient(
                step: step,
                timeConstant: tuning.noiseFloorFallSeconds
            )
            noiseFloorDecibels += (observed - noiseFloorDecibels)
                * Float(coefficient)
        } else {
            let rise = tuning.noiseFloorRiseDecibelsPerSecond * Float(step)
            noiseFloorDecibels = min(noiseFloorDecibels + rise, observed)
        }

        noiseFloorDecibels = min(
            max(noiseFloorDecibels, tuning.noiseFloorLimitDecibels),
            tuning.noiseFloorCeilingDecibels
        )
    }

    /// The per-frame share of an exponential approach with the given time
    /// constant. Deriving it from the frame duration is what makes the envelope
    /// independent of how often it is fed.
    private static func coefficient(
        step: TimeInterval,
        timeConstant: TimeInterval
    ) -> Double {
        guard timeConstant > 0 else {
            return 1
        }
        return 1 - exp(-step / timeConstant)
    }
}

/// Downsamples a whole recording into the fixed number of bars the saved-note
/// waveform draws. Pure, so the tests feed it crafted PCM instead of a file.
enum VoiceWaveformBucketing {
    /// Decibels below the loudest bucket that still draw as visible height.
    /// Wider than the live span because a saved note is read as a shape, not
    /// as a moment.
    static let dynamicRangeDecibels: Float = 45
    static let contourExponent: Float = 0.8

    static func bars(from samples: [Float], barCount: Int) -> [Double] {
        guard barCount > 0, !samples.isEmpty else {
            return []
        }

        var bucketDecibels = [Float]()
        bucketDecibels.reserveCapacity(barCount)
        for index in 0..<barCount {
            let lower = samples.count * index / barCount
            let upper = max(samples.count * (index + 1) / barCount, lower + 1)
            let bucket = samples[lower..<min(upper, samples.count)]
            bucketDecibels.append(
                VoiceWaveformAnalyzer.analyze(Array(bucket), sampleRate: 1)
                    .decibels
            )
        }

        let peak = bucketDecibels.max() ?? VoiceWaveformAnalyzer.silenceDecibels
        guard peak > VoiceWaveformAnalyzer.silenceDecibels else {
            return Array(repeating: 0, count: barCount)
        }

        let floor = peak - dynamicRangeDecibels
        return bucketDecibels.map { decibels in
            let normalized = min(
                max((decibels - floor) / dynamicRangeDecibels, 0),
                1
            )
            return Double(pow(normalized, contourExponent))
        }
    }
}

/// Where the playback head sits. Progress, not decoration: it keeps moving
/// under Reduced Motion.
enum VoiceWaveformPlayhead {
    static func progress(
        currentTime: TimeInterval,
        duration: TimeInterval
    ) -> Double {
        guard duration > 0, currentTime.isFinite, duration.isFinite else {
            return 0
        }
        return min(max(currentTime / duration, 0), 1)
    }

    /// How many of `barCount` bars sit left of the head. Any started playback
    /// colours at least one bar, so the head is visible the instant it moves.
    static func playedBarCount(progress: Double, barCount: Int) -> Int {
        guard barCount > 0 else {
            return 0
        }
        guard progress > 0 else {
            return 0
        }
        guard progress < 1 else {
            return barCount
        }
        return min(max(Int(ceil(progress * Double(barCount))), 1), barCount)
    }
}
