import Foundation
import XCTest
@testable import SnapList

/// The voice meter's arithmetic, exercised with crafted PCM rather than a
/// microphone. Everything under test here is pure: no AVFoundation, no audio
/// session, no device. Expected values are hand-computed from the signal
/// definition (20·log10 of a known amplitude, a known sine frequency over
/// Nyquist), never recomputed the way the implementation computes them.
final class VoiceWaveformDSPTests: XCTestCase {
    private let sampleRate: Double = 16_000
    private let windowLength = 1_024

    // MARK: - Analyzer

    func testAnalyzerReportsRootMeanSquareAndDecibelsOfKnownAmplitudes() {
        let silence = VoiceWaveformAnalyzer.analyze(
            Array(repeating: 0, count: windowLength),
            sampleRate: sampleRate
        )
        XCTAssertEqual(silence.rootMeanSquare, 0, accuracy: 0.0001)
        XCTAssertEqual(
            silence.decibels,
            VoiceWaveformAnalyzer.silenceDecibels,
            "Digital silence must land on the published floor, not -infinity."
        )
        XCTAssertEqual(silence.brightness, 0, accuracy: 0.0001)

        // A full-scale sine has RMS 1/sqrt(2) = 0.70711, i.e. -3.0103 dBFS.
        let fullScale = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 1_000, amplitude: 1),
            sampleRate: sampleRate
        )
        XCTAssertEqual(fullScale.rootMeanSquare, 0.70711, accuracy: 0.005)
        XCTAssertEqual(fullScale.decibels, -3.0103, accuracy: 0.1)

        // A quarter-scale sine has RMS 0.17678, i.e. -15.0515 dBFS.
        let quarterScale = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 1_000, amplitude: 0.25),
            sampleRate: sampleRate
        )
        XCTAssertEqual(quarterScale.rootMeanSquare, 0.17678, accuracy: 0.005)
        XCTAssertEqual(quarterScale.decibels, -15.0515, accuracy: 0.1)
    }

    func testAnalyzerBrightnessTracksSpectralCentroidOverNyquist() {
        let low = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 800, amplitude: 0.3),
            sampleRate: sampleRate
        )
        let high = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 6_400, amplitude: 0.3),
            sampleRate: sampleRate
        )

        // Nyquist is 8 kHz, so a pure 800 Hz tone must land on 0.1 and a pure
        // 6.4 kHz tone on 0.8 of the normalized centroid range.
        XCTAssertEqual(low.brightness, 0.1, accuracy: 0.03)
        XCTAssertEqual(high.brightness, 0.8, accuracy: 0.03)
        XCTAssertGreaterThan(high.brightness, low.brightness + 0.3)
    }

    func testAnalyzerToleratesShortAndEmptyWindows() {
        let empty = VoiceWaveformAnalyzer.analyze([], sampleRate: sampleRate)
        XCTAssertEqual(empty.rootMeanSquare, 0)
        XCTAssertEqual(empty.decibels, VoiceWaveformAnalyzer.silenceDecibels)
        XCTAssertEqual(empty.brightness, 0)

        let single = VoiceWaveformAnalyzer.analyze([0.5], sampleRate: sampleRate)
        XCTAssertEqual(single.rootMeanSquare, 0.5, accuracy: 0.0001)
        XCTAssertEqual(
            single.brightness,
            0,
            "One sample cannot carry a spectral centroid."
        )
    }

    // MARK: - Envelope

    func testQuietLoudAndSibilantSpeechYieldAtLeastThreeDistinctBarHeights() {
        // Settle the tracker on room tone first, then measure each utterance
        // from that same settled floor. Copies are free: the envelope is a
        // value type precisely so a test can branch it.
        var settledOnRoomTone = VoiceMeterEnvelope()
        let roomTone = level(
            of: sine(frequency: 120, amplitude: 0.004),
            frames: 200,
            into: &settledOnRoomTone
        )

        let quietSpeech = level(
            of: sine(frequency: 300, amplitude: 0.03),
            frames: 25,
            from: settledOnRoomTone
        )
        let loudSpeech = level(
            of: sine(frequency: 300, amplitude: 0.35),
            frames: 25,
            from: settledOnRoomTone
        )
        let sibilant = level(
            of: chord(frequencies: [5_000, 6_000, 7_000], amplitude: 0.12),
            frames: 25,
            from: settledOnRoomTone
        )

        let heights = [roomTone, quietSpeech, loudSpeech, sibilant].map {
            VoiceWaveformBarPolicy.barHeight(amplitude: $0, maximumHeight: 60)
        }
        XCTAssertGreaterThanOrEqual(
            distinctLevelCount(heights, separation: 3),
            3,
            """
            Room tone, quiet speech and loud speech must read as three separate \
            bar heights; the linear -60…0 dB map collapsed them into two. \
            Heights were \(heights).
            """
        )

        XCTAssertLessThan(roomTone, 0.08, "A pause must read as a pause.")
        XCTAssertGreaterThan(quietSpeech, roomTone + 0.15)
        XCTAssertGreaterThan(loudSpeech, quietSpeech + 0.15)

        // The sibilant burst is 14 dB quieter than the loud vowel yet must not
        // read like a quiet one: spectral brightness is what buys it height.
        XCTAssertGreaterThan(sibilant, quietSpeech + 0.2)

        var flatOnRoomTone = VoiceMeterEnvelope(
            tuning: VoiceMeterEnvelope.Tuning(brightnessWeight: 0)
        )
        _ = level(
            of: sine(frequency: 120, amplitude: 0.004),
            frames: 200,
            into: &flatOnRoomTone
        )
        let flatSibilant = level(
            of: chord(frequencies: [5_000, 6_000, 7_000], amplitude: 0.12),
            frames: 25,
            from: flatOnRoomTone
        )
        XCTAssertGreaterThan(
            sibilant,
            flatSibilant + 0.04,
            "Brightness weighting, not amplitude, must be what lifts a sibilant."
        )
    }

    func testNoiseFloorAdaptsSoTheSameSpeechReadsDifferentlyInDifferentRooms() {
        let voice = sine(frequency: 300, amplitude: 0.03)

        var quietRoom = VoiceMeterEnvelope()
        _ = level(
            of: sine(frequency: 120, amplitude: 0.0005),
            frames: 200,
            into: &quietRoom
        )
        let quietRoomFloor = quietRoom.noiseFloorDecibels
        let inQuietRoom = level(of: voice, frames: 25, from: quietRoom)

        var loudRoom = VoiceMeterEnvelope()
        _ = level(
            of: sine(frequency: 120, amplitude: 0.02),
            frames: 900,
            into: &loudRoom
        )
        let loudRoomFloor = loudRoom.noiseFloorDecibels
        let inLoudRoom = level(of: voice, frames: 25, from: loudRoom)

        XCTAssertLessThan(
            quietRoomFloor,
            loudRoomFloor - 15,
            "The tracked floor must follow the room, not stay pinned at -60 dB."
        )
        XCTAssertGreaterThan(
            inQuietRoom,
            inLoudRoom + 0.2,
            """
            Identical speech must read taller in a quiet room than in a noisy \
            one. Quiet room \(inQuietRoom) at floor \(quietRoomFloor); loud \
            room \(inLoudRoom) at floor \(loudRoomFloor).
            """
        )
        XCTAssertLessThanOrEqual(
            loudRoomFloor,
            VoiceMeterEnvelope.Tuning().noiseFloorCeilingDecibels
        )
        XCTAssertGreaterThanOrEqual(
            quietRoomFloor,
            VoiceMeterEnvelope.Tuning().noiseFloorLimitDecibels
        )
    }

    func testAttackRisesFasterThanReleaseAndNeitherSnaps() {
        var envelope = VoiceMeterEnvelope()
        let loud = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 300, amplitude: 0.5),
            sampleRate: sampleRate
        )
        let silent = VoiceWaveformAnalyzer.analyze(
            Array(repeating: 0, count: windowLength),
            sampleRate: sampleRate
        )
        let frameDuration = VoiceMeterEnvelope.nominalFrameDuration

        let firstRise = envelope.ingest(loud, frameDuration: frameDuration)
        XCTAssertGreaterThan(firstRise, 0, "Attack must start immediately.")
        XCTAssertLessThan(
            firstRise,
            0.75,
            "One frame must not snap the meter to its target."
        )

        var settled = firstRise
        for _ in 0..<40 {
            settled = envelope.ingest(loud, frameDuration: frameDuration)
        }
        XCTAssertGreaterThan(settled, firstRise)

        let firstFall = envelope.ingest(silent, frameDuration: frameDuration)
        XCTAssertLessThan(firstFall, settled)
        XCTAssertGreaterThan(
            firstFall,
            settled * 0.5,
            "Release must decay, not drop to zero in one frame."
        )
        XCTAssertLessThan(
            settled - firstFall,
            firstRise,
            "A single release step must be smaller than a single attack step."
        )

        var decayed = firstFall
        for _ in 0..<80 {
            decayed = envelope.ingest(silent, frameDuration: frameDuration)
        }
        XCTAssertLessThan(decayed, 0.05, "Silence must eventually reach rest.")
    }

    func testEnvelopeIsRateIndependentAcrossPollingIntervals() {
        let loud = VoiceWaveformAnalyzer.analyze(
            sine(frequency: 300, amplitude: 0.5),
            sampleRate: sampleRate
        )

        var fast = VoiceMeterEnvelope()
        for _ in 0..<100 {
            _ = fast.ingest(loud, frameDuration: 1.0 / 100.0)
        }
        var slow = VoiceMeterEnvelope()
        for _ in 0..<20 {
            _ = slow.ingest(loud, frameDuration: 1.0 / 20.0)
        }

        XCTAssertEqual(
            fast.level,
            slow.level,
            accuracy: 0.03,
            """
            One second of the same signal must land on the same level whether \
            it arrived as 100 frames or 20, so the recorder-meter fallback and \
            the engine tap agree.
            """
        )
    }

    // MARK: - Saved-note bucketing

    func testFileBucketingDownsamplesToTheRequestedBarCount() {
        let tone = sine(frequency: 440, amplitude: 0.5, count: 48_000)
        let bars = VoiceWaveformBucketing.bars(from: tone, barCount: 24)

        XCTAssertEqual(bars.count, 24)
        XCTAssertEqual(bars.max() ?? 0, 1, accuracy: 0.0001)
        for bar in bars {
            XCTAssertEqual(
                bar,
                1,
                accuracy: 0.05,
                "A constant tone must produce a flat, full-height waveform."
            )
        }
    }

    func testFileBucketingPlacesSilenceAndSpeechInTheRightBuckets() {
        let silence = [Float](repeating: 0, count: 24_000)
        let tone = sine(frequency: 440, amplitude: 0.5, count: 24_000)
        let bars = VoiceWaveformBucketing.bars(
            from: silence + tone,
            barCount: 24
        )

        XCTAssertEqual(bars.count, 24)
        for bar in bars.prefix(12) {
            XCTAssertEqual(bar, 0, accuracy: 0.02)
        }
        for bar in bars.suffix(12) {
            XCTAssertGreaterThan(bar, 0.9)
        }
    }

    func testFileBucketingRanksARampMonotonicallyAndGuardsDegenerateInput() {
        let ramp = (0..<24_000).map { index in
            Float(index) / 24_000 * 0.8
        }
        let bars = VoiceWaveformBucketing.bars(from: ramp, barCount: 16)

        XCTAssertEqual(bars.count, 16)
        for index in 1..<bars.count {
            XCTAssertGreaterThan(
                bars[index],
                bars[index - 1],
                "A rising ramp must produce strictly rising bars."
            )
        }

        XCTAssertEqual(VoiceWaveformBucketing.bars(from: [], barCount: 24), [])
        XCTAssertEqual(VoiceWaveformBucketing.bars(from: ramp, barCount: 0), [])
        XCTAssertEqual(
            VoiceWaveformBucketing.bars(from: ramp, barCount: -3),
            []
        )
        XCTAssertEqual(
            VoiceWaveformBucketing.bars(
                from: [Float](repeating: 0, count: 4_000),
                barCount: 8
            ),
            Array(repeating: 0, count: 8),
            "An all-silent file must render flat, never normalize noise up."
        )
        XCTAssertEqual(
            VoiceWaveformBucketing.bars(from: [0.5, -0.5, 0.5], barCount: 8)
                .count,
            8,
            "Fewer samples than bars must still fill the requested width."
        )
    }

    // MARK: - Playhead

    func testPlayheadProgressIsAPureFunctionOfCurrentTimeOverDuration() {
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: 6, duration: 12),
            0.5,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: 0, duration: 12),
            0,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: 12, duration: 12),
            1,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: 99, duration: 12),
            1,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: -4, duration: 12),
            0,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.progress(currentTime: 3, duration: 0),
            0,
            accuracy: 0.0001,
            "An unknown duration must not divide by zero."
        )
    }

    func testPlayheadSplitsBarsIntoPlayedAndUnplayedRuns() {
        XCTAssertEqual(
            VoiceWaveformPlayhead.playedBarCount(progress: 0, barCount: 24),
            0
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.playedBarCount(progress: 0.5, barCount: 24),
            12
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.playedBarCount(progress: 1, barCount: 24),
            24
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.playedBarCount(progress: 0.01, barCount: 24),
            1,
            "Any started playback must colour at least the first bar."
        )
        XCTAssertEqual(
            VoiceWaveformPlayhead.playedBarCount(progress: 0.5, barCount: 0),
            0
        )
    }

    // MARK: - Bar policy

    func testBarCountIsDerivedFromTheCapAndThePitchNotHardcoded() {
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barCount(duration: 15, secondsPerBar: 0.2),
            75
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barCount(duration: 10, secondsPerBar: 0.2),
            50,
            "Bar count must scale with duration, not stay pinned to one screen's constant."
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barCount(duration: 15, secondsPerBar: 0.5),
            30,
            "Bar count must also scale with pitch."
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barCount(duration: 0, secondsPerBar: 0.2),
            0
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barCount(duration: 15, secondsPerBar: 0),
            0,
            "A zero pitch must not divide by zero."
        )
    }

    func testBarHeightMapsSilenceToTheMinimumAndFullScaleToFullHeightMonotonically() {
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barHeight(amplitude: 0, maximumHeight: 40),
            VoiceWaveformBarPolicy.minimumBarHeight
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barHeight(amplitude: 1, maximumHeight: 40),
            40
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barHeight(amplitude: -1, maximumHeight: 40),
            VoiceWaveformBarPolicy.minimumBarHeight,
            "Out-of-range amplitude must clamp rather than draw below the floor."
        )
        XCTAssertEqual(
            VoiceWaveformBarPolicy.barHeight(amplitude: 2, maximumHeight: 40),
            40,
            "Out-of-range amplitude must clamp rather than overshoot the ceiling."
        )

        let ascending = stride(from: 0.0, through: 1.0, by: 0.1).map {
            VoiceWaveformBarPolicy.barHeight(amplitude: $0, maximumHeight: 40)
        }
        XCTAssertEqual(
            ascending,
            ascending.sorted(),
            "Louder amplitude must never draw a shorter bar."
        )
    }

    // MARK: - Signal helpers

    private func sine(
        frequency: Double,
        amplitude: Float,
        count: Int? = nil
    ) -> [Float] {
        let length = count ?? windowLength
        return (0..<length).map { index in
            amplitude * Float(
                sin(2 * Double.pi * frequency * Double(index) / sampleRate)
            )
        }
    }

    private func chord(
        frequencies: [Double],
        amplitude: Float,
        count: Int? = nil
    ) -> [Float] {
        let length = count ?? windowLength
        let scale = amplitude / Float(frequencies.count)
        return (0..<length).map { index in
            frequencies.reduce(Float(0)) { partial, frequency in
                partial + scale * Float(
                    sin(
                        2 * Double.pi * frequency * Double(index) / sampleRate
                    )
                )
            }
        }
    }

    private func level(
        of samples: [Float],
        frames: Int,
        into envelope: inout VoiceMeterEnvelope
    ) -> Double {
        let frame = VoiceWaveformAnalyzer.analyze(
            samples,
            sampleRate: sampleRate
        )
        var current = envelope.level
        for _ in 0..<max(frames, 1) {
            current = envelope.ingest(
                frame,
                frameDuration: VoiceMeterEnvelope.nominalFrameDuration
            )
        }
        return current
    }

    private func level(
        of samples: [Float],
        frames: Int,
        from envelope: VoiceMeterEnvelope
    ) -> Double {
        var branched = envelope
        return level(of: samples, frames: frames, into: &branched)
    }

    private func distinctLevelCount(
        _ heights: [CGFloat],
        separation: CGFloat
    ) -> Int {
        var clusters: [CGFloat] = []
        for height in heights.sorted() {
            if let last = clusters.last, height - last < separation {
                continue
            }
            clusters.append(height)
        }
        return clusters.count
    }
}
