# Video Summary MVP Design

Date: 2026-05-23

## Goal

Build the first reliable video summary loop for Safarai. When the user opens a YouTube, Bilibili, or generic page with a primary video in Safari, Safarai should show a video summary entry point, refresh the current page context, summarize the video from available evidence, and allow the conversation to continue from that result.

This is not a rewrite of the video summary feature. The repository already has the main pieces: video page detection, transcript extraction, a `summarize_video` task intent, video frame sampling, and provider prompt paths. This design focuses on making that existing loop coherent, testable, and safe for a first usable release.

## Scope

In scope:

- Show the video summary entry point for YouTube video pages, Bilibili video pages, and generic pages with a primary video.
- Hide the entry point on non-video pages so normal page Q&A is not disturbed.
- Refresh page context before sending a video summary request.
- Use transcript segments, page metadata, page text, chapters or timestamp signals, and comment attention signals when available.
- Trigger video frame sampling when a video is detected but timestamped transcript context is sparse.
- Keep text prompt behavior consistent across Codex, Zed, and OpenAI-compatible providers.
- Allow OpenAI-compatible providers to use attached sampled video frames as an additional multimodal signal.
- Clearly degrade when transcript or frame evidence is insufficient.
- Add automated tests for the core context and entry-point conditions.
- Document a focused Safari manual test checklist.

Out of scope:

- Downloading video files.
- Background batch summarization.
- Summarizing videos the user has not opened.
- Building a full video RAG system or complete long-video chunking pipeline.
- Replacing platform-specific DOM extraction with official YouTube or Bilibili APIs.
- Reworking the panel UI beyond the existing video summary entry point and necessary state behavior.
- Forcing Codex or Zed to consume image inputs if their current request paths do not support that safely.

## Success Criteria

- YouTube video pages with transcript or chapter signals produce Markdown with `## 整体概览`, `## 时间线要点`, and `## 适合快速记住的结论`.
- Timeline bullets cite available timestamps when transcript or chapter timestamps exist.
- Bilibili video pages are recognized, and visible subtitle or subtitle-panel candidates are included when present.
- Generic pages with a primary `<video>` expose the video summary entry point.
- Videos without usable timestamped transcript context degrade honestly instead of inventing details.
- Codex, Zed, and OpenAI-compatible providers share the same text-level video summary requirements.
- OpenAI-compatible providers may additionally use sampled frames when available.
- Automated tests cover the main video context detection and entry-point conditions.
- A manual Safari checklist exists for the core end-to-end scenarios.

## Architecture

The existing architecture remains in place:

- `page-context.js` is the pure extraction core. It detects page kind, primary video presence, video metadata, transcript segments, and video RAG signals. It should remain unit-testable without real Safari state.
- `content.js` and `background.js` handle real Safari runtime behavior: context sync, explicit refresh, preparing video playback positions, and visible-tab frame capture.
- `PanelStateWriter` and `PanelStateStore` persist the shared context between the Safari extension and native host. Video fields must survive normalization.
- `ViewController.swift` owns the request flow. It distinguishes normal questions from `summarize_video`, refreshes page context, conditionally waits for frame sampling, and starts the provider request.
- `CodexResponseService.swift`, `ZedResponseService.swift`, and `OpenAICompatibleResponseService.swift` assemble provider prompts. Their text requirements for video summary should remain aligned.
- `Panel.js`, `Panel.html`, and `Panel.css` keep the product surface small: show or hide the existing video summary button based on current context and send `taskIntent: "summarize_video"` when clicked.

This keeps each layer narrow: extraction produces evidence, the host decides when to refresh or sample, providers format the evidence for the model, and the panel exposes the user action.

## Data Flow

1. The panel renders the video summary button only when context indicates `pageKind` is `youtube_video` or `bilibili_video`, or metadata says `hasPrimaryVideo` is `true`.
2. The user clicks the button. The panel sends a normal chat request with the video summary prompt and `taskIntent: "summarize_video"`.
3. `ViewController` sees the task intent and calls the video-specific refresh path.
4. The host first requests fresh page context from Safari and waits briefly for a newer usable snapshot.
5. If the refreshed context indicates a video and fewer than three transcript segments, the host asks the extension to sample video frames.
6. `background.js` asks the content script to seek or prepare selected timestamps, captures visible tab frames when possible, adds `videoFrameSamples` plus frame metadata, and syncs the enriched context.
7. The host uses the best available snapshot to build the provider request.
8. The provider request includes page title, URL, selected text when relevant, article text, structure summary, visual summary, video RAG signals, transcript segments, and frame sample references where supported.
9. The answer streams back into the current chat as part of the ongoing conversation.

## Degradation Rules

Evidence levels:

- Full evidence: transcript, chapters, description, or timestamp signals exist. The model must use available timestamps in the timeline section.
- Sparse transcript evidence: fewer than three transcript segments exist but frame sampling succeeds. OpenAI-compatible requests may use sampled images. Text-only providers still rely on title, description, page text, structure, and RAG signals.
- Minimal evidence: no useful transcript and no usable frame samples. The answer must begin by stating that no usable timestamped transcript was detected and then provide only a brief summary based on the title, description, and visible page information.

Safety rules:

- Do not present comments as video facts. Comments can only be described as collective attention signals unless supported by transcript, description, or visible content.
- Do not invent transcript content.
- Do not imply the whole video was watched when only page metadata or sampled frames were available.
- If frame sampling fails due to permissions, playback state, or capture limitations, continue with text-only degradation rather than blocking the request.

## Provider Behavior

All providers should share these text output requirements for `summarize_video`:

- Output Markdown with three sections: `## 整体概览`, `## 时间线要点`, and `## 适合快速记住的结论`.
- Timeline points should cite timestamps when available, using a format like `00:00-02:15：要点`.
- Use page structure, video title, description, chapters, important moments, comment attention signals, and transcript evidence.
- Treat comments as attention signals, not verified video facts.
- Avoid fabricating details that are not in the provided evidence.
- If no transcript is available, explicitly say so before the degraded summary.

OpenAI-compatible keeps the existing multimodal path: when `videoFrameSamples` are present, it may attach up to the existing sample limit as low-detail images and reference them in the text prompt. Codex and Zed remain text-only unless their request paths later gain safe image support.

## Testing Plan

Automated tests:

- Extend or preserve `tests/page-context.test.js` coverage for YouTube title, author, description, transcript segments, chapter signals, and comment timestamp attention signals.
- Cover YouTube text-track cues when transcript DOM is unavailable.
- Cover Bilibili title, UP name, description, and visible subtitle candidates.
- Cover generic pages with a primary video setting `metadata.hasPrimaryVideo` and an empty transcript list.
- Add or preserve a testable entry-point predicate for video summary visibility: YouTube video, Bilibili video, or `hasPrimaryVideo=true` should show the button; non-video pages should hide it.
- Verify video-related fields survive shared-state normalization: `videoTranscript`, `videoRAGSummary`, `videoFrameSamples`, and frame sample metadata.

Manual Safari checklist:

- YouTube with usable captions: the button appears, the answer has the three required sections, and timeline points include timestamps.
- YouTube with sparse or unavailable captions: the answer clearly degrades and does not invent a full transcript.
- Bilibili video page: the button appears, title/UP/description/subtitle candidates are reflected when available.
- Generic page with one primary video: the button appears; if no captions exist, the answer explains the limitation.
- Non-video page: the button stays hidden and normal page Q&A still works.
- Detached page context: if the user has detached the current page context, video summary does not silently reuse that detached page as active context.

## Implementation Order

1. Align video summary prompt requirements across providers while preserving OpenAI-compatible image attachment support.
2. Add focused tests for visibility predicates, video context fields, and shared-state field preservation.
3. Patch only the minimum runtime gaps found by those tests.
4. Run the automated test suite.
5. Execute the Safari manual checklist and record any limitations for follow-up.

## Risks And Controls

- Platform DOM changes can break extraction. Use multiple selectors and honest degradation rather than relying on one fragile selector.
- Safari frame capture may fail due to permissions, cross-origin restrictions, playback state, or inactive windows. Treat frame sampling as optional evidence.
- Provider capabilities differ. Keep text behavior consistent and limit multimodal behavior to OpenAI-compatible for this release.
- Long videos can exceed context limits. Keep the existing transcript cap for the MVP and defer full chunking.
- The button could appear incorrectly. Gate it on `pageKind` or explicit `hasPrimaryVideo` metadata and cover that with tests.

## Follow-Up Ideas

- Add chunked transcript summarization for long videos.
- Add richer user controls for summary style, language, and depth.
- Persist video summary source diagnostics for debugging.
- Explore official or user-authorized transcript APIs if platform DOM extraction proves too fragile.
