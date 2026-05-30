import Foundation
import Speech

/// On-device transcription via Apple's Speech framework. Per-word segments are grouped
/// into ~12s chunks so the summary gets coarse, useful timestamps.
enum AppleSpeechTranscriber {
    static func transcribe(fileURL: URL) async -> [PanelVideoTranscriptSegment]? {
        guard await authorized(), let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            return nil
        }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.shouldReportPartialResults = false

        let words: [(start: Double, duration: Double, text: String)]? = await withCheckedContinuation { continuation in
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                if error != nil {
                    if !resumed { resumed = true; continuation.resume(returning: nil) }
                    return
                }
                guard let result, result.isFinal else { return }
                let segs = result.bestTranscription.segments.map {
                    (start: $0.timestamp, duration: $0.duration, text: $0.substring)
                }
                if !resumed { resumed = true; continuation.resume(returning: segs) }
            }
        }

        guard let words, !words.isEmpty else { return nil }
        return group(words)
    }

    private static func authorized() async -> Bool {
        if SFSpeechRecognizer.authorizationStatus() == .authorized { return true }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }

    private static func group(_ words: [(start: Double, duration: Double, text: String)]) -> [PanelVideoTranscriptSegment] {
        var segments: [PanelVideoTranscriptSegment] = []
        var chunkStart = words[0].start
        var chunkText = ""
        var lastEnd = words[0].start
        func flush() {
            let text = chunkText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            segments.append(PanelVideoTranscriptSegment(
                startSeconds: chunkStart, endSeconds: lastEnd,
                timestamp: TranscriptFormat.timestamp(chunkStart), text: text, source: "apple_speech"
            ))
        }
        for word in words {
            if word.start - chunkStart >= 12, !chunkText.isEmpty {
                flush()
                chunkStart = word.start
                chunkText = ""
            }
            chunkText += word.text + " "
            lastEnd = word.start + word.duration
        }
        flush()
        return segments
    }
}
