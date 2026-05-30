import Foundation

/// Downloads a page-exposed audio stream and transcribes it via the OpenAI-compatible
/// `/audio/transcriptions` endpoint (Whisper-class), returning timestamped segments.
/// Used as the fallback when a video has no fetchable caption track.
enum VideoTranscriptionService {
    /// OpenAI-compatible transcription model id. Most servers expose `whisper-1`.
    private static let model = "whisper-1"
    /// Stay under the common 25 MB upload limit for transcription endpoints.
    private static let maxAudioBytes = 24 * 1024 * 1024

    static func transcribe(
        audioURL: String,
        referer: String?,
        filename: String = "audio.mp4"
    ) async -> [PanelVideoTranscriptSegment]? {
        guard let mediaURL = URL(string: audioURL) else { return nil }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 300
        let session = URLSession(configuration: config)

        guard
            let audioData = await downloadAudio(mediaURL, referer: referer, session: session),
            let fileURL = writeTempFile(audioData, filename: filename)
        else {
            return nil
        }
        defer { try? FileManager.default.removeItem(at: fileURL) }

        switch sttEngine() {
        case "apple_speech":
            return await AppleSpeechTranscriber.transcribe(fileURL: fileURL)
        case "local_whisper":
            return await LocalWhisperTranscriber.transcribe(fileURL: fileURL)
        default:
            return await remoteTranscribe(audioData: audioData, filename: filename, session: session)
        }
    }

    /// Selected STT engine from ui-settings.json: remote | apple_speech | local_whisper.
    private static func sttEngine() -> String {
        let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let engine = json["stt_engine"] as? String
        else {
            return "remote"
        }
        return engine
    }

    private static func writeTempFile(_ data: Data, filename: String) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("safarai-\(UUID().uuidString)-\(filename)")
        guard (try? data.write(to: url)) != nil else { return nil }
        return url
    }

    private static func remoteTranscribe(audioData: Data, filename: String, session: URLSession) async -> [PanelVideoTranscriptSegment]? {
        let settings = OpenAICompatibleSettingsStore.load()
        guard
            settings.isConfigured,
            let uploadURL = endpointURL(settings.endpoint, path: "audio/transcriptions")
        else {
            return nil
        }

        let boundary = "safarai-\(UUID().uuidString)"
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let body = multipartBody(
            boundary: boundary,
            audio: audioData,
            filename: filename,
            fields: [
                "model": model,
                "response_format": "verbose_json",
                "timestamp_granularities[]": "segment",
            ]
        )

        guard
            let (data, response) = try? await session.upload(for: request, from: body),
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode)
        else {
            return nil
        }

        return parseSegments(data)
    }

    private static func downloadAudio(_ url: URL, referer: String?, session: URLSession) async -> Data? {
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        if let referer, !referer.isEmpty {
            request.setValue(referer, forHTTPHeaderField: "Referer")
        }
        guard
            let (data, response) = try? await session.data(for: request),
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            !data.isEmpty,
            data.count <= maxAudioBytes
        else {
            return nil
        }
        return data
    }

    private static func parseSegments(_ data: Data) -> [PanelVideoTranscriptSegment]? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let segments = json["segments"] as? [[String: Any]], !segments.isEmpty {
            let parsed = segments.compactMap { seg -> PanelVideoTranscriptSegment? in
                let text = (seg["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !text.isEmpty else { return nil }
                let start = (seg["start"] as? Double) ?? 0
                let end = seg["end"] as? Double
                return PanelVideoTranscriptSegment(
                    startSeconds: start,
                    endSeconds: end,
                    timestamp: timestamp(start),
                    text: text,
                    source: "asr_whisper"
                )
            }
            return parsed.isEmpty ? nil : parsed
        }
        // Fallback: plain transcription text with no segment timing.
        if let text = (json["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return [PanelVideoTranscriptSegment(startSeconds: 0, endSeconds: nil, timestamp: "0:00", text: text, source: "asr_whisper")]
        }
        return nil
    }

    private static func multipartBody(boundary: String, audio: Data, filename: String, fields: [String: String]) -> Data {
        var body = Data()
        let prefix = "--\(boundary)\r\n"
        for (key, value) in fields {
            body.append(prefix.data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        body.append(prefix.data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }

    /// Mirrors OpenAICompatibleResponseService.endpointURL so STT hits the same base as chat.
    private static func endpointURL(_ endpoint: String, path: String) -> URL? {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
            return nil
        }
        var basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for suffix in ["chat/completions", "models"] where basePath.hasSuffix(suffix) {
            basePath = String(basePath.dropLast(suffix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        components.path = "/" + [basePath, path].filter { !$0.isEmpty }.joined(separator: "/")
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func timestamp(_ totalSeconds: Double) -> String {
        let seconds = max(0, Int(totalSeconds.rounded()))
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
