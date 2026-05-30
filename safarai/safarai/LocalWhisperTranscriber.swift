import Foundation

/// Shared timestamp formatter for transcript segments (mm:ss / h:mm:ss).
enum TranscriptFormat {
    static func timestamp(_ totalSeconds: Double) -> String {
        let seconds = max(0, Int(totalSeconds.rounded()))
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

/// On-device open-source Whisper transcription (WhisperKit). Stubbed until the WhisperKit
/// dependency is wired in; returns nil so the dispatcher falls back gracefully.
enum LocalWhisperTranscriber {
    static func transcribe(fileURL: URL) async -> [PanelVideoTranscriptSegment]? {
        _ = fileURL
        return nil
    }
}
