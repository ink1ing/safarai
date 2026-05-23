# Video Summary MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Safarai video summary path reliable for a first usable release across YouTube, Bilibili, and generic primary-video pages.

**Architecture:** Keep the current Safari extension plus native host architecture. Add a small pure JS predicate for panel video summary visibility, preserve video evidence through shared state, align provider prompt requirements, and verify the core loop with focused automated tests plus a manual Safari checklist.

**Tech Stack:** Swift/AppKit Safari extension host, Safari Web Extension JavaScript, local WKWebView panel JavaScript/CSS/HTML, Node.js built-in `node:test`, Xcode manual build/run.

---

## File Structure

- Create `safarai/safarai/Resources/shared/video-summary.js`: Pure browser-safe helper for deciding whether the panel should show the video summary action.
- Modify `safarai/safarai/Resources/Panel.js`: Replace the inline video visibility condition with the shared helper loaded from a global.
- Modify `safarai/safarai/Resources/Base.lproj/Panel.html`: Load the new helper before `Panel.js`.
- Create `tests/video-summary.test.js`: Unit tests for the video summary visibility predicate.
- Modify `tests/page-context.test.js`: Add one focused no-transcript video context regression test if the current coverage does not already assert all fields needed by the MVP.
- Create `tests/panel-state-writer.test.swift`: Swift smoke test source for `PanelStateWriter` normalization, run manually with `swiftc` against extension Swift files.
- Modify `safarai/safarai/CodexResponseService.swift`: Align video summary prompt requirements with the MVP spec, including frame sample count metadata without image input.
- Modify `safarai/safarai/ZedResponseService.swift`: Match the same text-level prompt requirements as Codex.
- Preserve `safarai/safarai/OpenAICompatibleResponseService.swift`: Keep its multimodal frame attachment behavior and use it as the canonical richer prompt shape.
- Create `docs/superpowers/manual-tests/video-summary-mvp.md`: Manual Safari checklist for the end-to-end scenarios.

## Commands

- Run all JS tests: `node --test tests/*.test.js`
- Run one JS test file: `node --test tests/video-summary.test.js`
- Run Swift normalization smoke test after Task 3: `swiftc -D SAFARAI_PANEL_STATE_WRITER_TEST tests/panel-state-writer.test.swift "safarai/safarai Extension/PanelStateWriter.swift" "safarai/safarai Extension/SharedContainer.swift" -o /tmp/safarai-panel-state-writer-test && /tmp/safarai-panel-state-writer-test`
- Inspect working tree: `git status --short --branch`

---

### Task 1: Extract Video Summary Visibility Predicate

**Files:**
- Create: `safarai/safarai/Resources/shared/video-summary.js`
- Create: `tests/video-summary.test.js`
- Modify: `safarai/safarai/Resources/Base.lproj/Panel.html`
- Modify: `safarai/safarai/Resources/Panel.js`

- [ ] **Step 1: Write the failing visibility tests**

Create `tests/video-summary.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowVideoSummary,
} from "../safarai/safarai/Resources/shared/video-summary.js";

test("shouldShowVideoSummary shows for YouTube and Bilibili video pages", () => {
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "youtube_video" } }),
    true
  );
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "bilibili_video" } }),
    true
  );
});

test("shouldShowVideoSummary shows for generic pages with a primary video", () => {
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "page", hasPrimaryVideo: "true" } }),
    true
  );
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "document", hasPrimaryVideo: true } }),
    true
  );
});

test("shouldShowVideoSummary hides for non-video pages and missing context", () => {
  assert.equal(shouldShowVideoSummary(null), false);
  assert.equal(shouldShowVideoSummary({}), false);
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "github_pull_request" } }),
    false
  );
  assert.equal(
    shouldShowVideoSummary({ metadata: { pageKind: "page", hasPrimaryVideo: "false" } }),
    false
  );
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node --test tests/video-summary.test.js
```

Expected: FAIL because `safarai/safarai/Resources/shared/video-summary.js` does not exist.

- [ ] **Step 3: Add the pure helper**

Create `safarai/safarai/Resources/shared/video-summary.js`:

```js
export function shouldShowVideoSummary(context) {
  const metadata = context?.metadata || {};
  const pageKind = String(metadata.pageKind || "");
  return (
    pageKind === "youtube_video" ||
    pageKind === "bilibili_video" ||
    String(metadata.hasPrimaryVideo || "") === "true"
  );
}

if (typeof window !== "undefined") {
  window.SafaraiVideoSummary = {
    shouldShowVideoSummary,
  };
}
```

- [ ] **Step 4: Run the visibility tests and verify they pass**

Run:

```bash
node --test tests/video-summary.test.js
```

Expected: PASS with three tests.

- [ ] **Step 5: Load the helper before the panel script**

Modify `safarai/safarai/Resources/Base.lproj/Panel.html` near the top script tag.

Replace:

```html
        <script src="../Panel.js" defer></script>
```

With:

```html
        <script src="../shared/video-summary.js" defer></script>
        <script src="../Panel.js" defer></script>
```

- [ ] **Step 6: Use the helper in `Panel.js`**

Modify `syncVideoSummaryButton()` in `safarai/safarai/Resources/Panel.js`.

Replace:

```js
function syncVideoSummaryButton() {
  const metadata = currentContext?.metadata || {};
  const pageKind = String(metadata.pageKind || "");
  const hasVideo =
    pageKind === "youtube_video" ||
    pageKind === "bilibili_video" ||
    String(metadata.hasPrimaryVideo || "") === "true";
  summarizeVideoButton.classList.toggle("is-hidden", !hasVideo);
  summarizeVideoButton.hidden = !hasVideo;
}
```

With:

```js
function syncVideoSummaryButton() {
  const hasVideo = window.SafaraiVideoSummary?.shouldShowVideoSummary(currentContext) ?? false;
  summarizeVideoButton.classList.toggle("is-hidden", !hasVideo);
  summarizeVideoButton.hidden = !hasVideo;
}
```

- [ ] **Step 7: Run all JS tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS. Existing page-context, protocol, session-store, log-store, and write-target tests should still pass.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add safarai/safarai/Resources/shared/video-summary.js \
  safarai/safarai/Resources/Base.lproj/Panel.html \
  safarai/safarai/Resources/Panel.js \
  tests/video-summary.test.js
git commit -m "test: cover video summary entry visibility"
```

---

### Task 2: Lock Video Context Extraction Regressions

**Files:**
- Modify: `tests/page-context.test.js`
- Test: `tests/page-context.test.js`

- [ ] **Step 1: Add a regression test for sparse generic video context**

Append this test after the existing `"普通页面含主 video 时会标记可显示视频总结入口"` test in `tests/page-context.test.js`:

```js
test("普通视频页无字幕时保留降级所需 metadata", () => {
  const video = createNode({
    tagName: "VIDEO",
    rect: { top: 12, left: 18, width: 800, height: 450, right: 818, bottom: 462 },
    duration: 392,
    currentTime: 31,
  });
  const doc = createDocument({
    title: "Product demo with silent video",
    selectors: {
      main: createNode({
        textContent:
          "This product page includes a silent walkthrough video and a short written overview. ".repeat(8),
      }),
      video,
    },
    selectorAll: {
      video: [video],
    },
  });
  const win = createWindow({
    href: "https://example.com/product-demo",
    hostname: "example.com",
    pathname: "/product-demo",
  });

  const result = extractPageContext(win, doc);

  assert.equal(result.metadata.pageKind, "page");
  assert.equal(result.metadata.hasPrimaryVideo, "true");
  assert.equal(result.metadata.videoDurationSeconds, "392");
  assert.equal(result.metadata.videoCurrentTimeSeconds, "31");
  assert.equal(result.metadata.videoTranscriptCount, "0");
  assert.equal(result.metadata.hasTranscript, "false");
  assert.deepEqual(result.videoTranscript, []);
  assert.match(result.articleText, /silent walkthrough video/);
});
```

- [ ] **Step 2: Run the page-context test**

Run:

```bash
node --test tests/page-context.test.js
```

Expected: PASS if current extraction already preserves these fields. If it fails, continue to Step 3 with the exact field that failed.

- [ ] **Step 3: Patch only missing extraction fields if the test fails**

If `videoDurationSeconds`, `videoCurrentTimeSeconds`, `videoTranscriptCount`, or `hasTranscript` is missing, update `extractVideoContext()` in `safarai/safarai Extension/Resources/shared/page-context.js` to keep this metadata shape:

```js
function extractVideoContext(win, doc, site) {
  const primaryVideo = findPrimaryVideo(win, doc);
  const domTranscript = extractDOMVideoTranscript(doc, site);
  const trackTranscript = extractTextTrackTranscript(primaryVideo);
  const visibleTranscript = extractVisibleSubtitleTranscript(doc, site, primaryVideo);
  const transcript = normalizeVideoTranscript([
    ...domTranscript,
    ...trackTranscript,
    ...visibleTranscript,
  ]);
  const transcriptSource = transcript[0]?.source ?? "";
  const duration = normalizeVideoNumber(primaryVideo?.duration);
  const currentTime = normalizeVideoNumber(primaryVideo?.currentTime);

  return {
    transcript,
    metadata: {
      hasPrimaryVideo: primaryVideo ? "true" : "false",
      videoDurationSeconds: duration == null ? "" : String(Math.round(duration)),
      videoCurrentTimeSeconds: currentTime == null ? "" : String(Math.round(currentTime)),
      videoTranscriptCount: String(transcript.length),
      videoTranscriptSource: transcriptSource,
      hasTranscript: transcript.length > 0 ? "true" : "false",
    },
  };
}
```

- [ ] **Step 4: Re-run the page-context test**

Run:

```bash
node --test tests/page-context.test.js
```

Expected: PASS.

- [ ] **Step 5: Run all JS tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add tests/page-context.test.js "safarai/safarai Extension/Resources/shared/page-context.js"
git commit -m "test: lock sparse video context metadata"
```

If Step 3 was not needed, omit `safarai/safarai Extension/Resources/shared/page-context.js` from `git add`.

---

### Task 3: Verify Shared-State Video Field Preservation

**Files:**
- Create: `tests/panel-state-writer.test.swift`
- Modify: `safarai/safarai Extension/PanelStateWriter.swift`

- [ ] **Step 1: Add a Swift smoke test for normalization**

Create `tests/panel-state-writer.test.swift`:

```swift
import Foundation

let context: [String: Any] = [
    "site": "youtube",
    "url": "https://www.youtube.com/watch?v=abc123",
    "title": "Captioned Video",
    "selection": "",
    "articleText": "video_title: Captioned Video",
    "videoRAGSummary": "salient_timestamp_signals:\n00:12 Important moment",
    "metadata": [
        "pageKind": "youtube_video",
        "hasPrimaryVideo": "true",
        "videoFrameSampleCount": 1,
    ],
    "videoTranscript": [
        [
            "startSeconds": 12,
            "endSeconds": 24,
            "timestamp": "00:12",
            "text": "Now we explain timestamped context.",
            "source": "text_track",
        ],
    ],
    "videoFrameSamples": [
        [
            "timestamp": "00:12",
            "timeSeconds": 12,
            "image": "data:image/jpeg;base64,abc123",
        ],
    ],
]

let normalized = PanelStateWriter.normalizeContextForTest(context)

guard normalized["videoRAGSummary"] as? String == "salient_timestamp_signals:\n00:12 Important moment" else {
    fatalError("videoRAGSummary was not preserved")
}

let metadata = normalized["metadata"] as? [String: String] ?? [:]
guard metadata["pageKind"] == "youtube_video",
      metadata["hasPrimaryVideo"] == "true",
      metadata["videoFrameSampleCount"] == "1"
else {
    fatalError("video metadata was not string-normalized and preserved")
}

let transcript = normalized["videoTranscript"] as? [[String: Any]] ?? []
guard transcript.count == 1,
      transcript[0]["timestamp"] as? String == "00:12",
      transcript[0]["text"] as? String == "Now we explain timestamped context."
else {
    fatalError("video transcript was not preserved")
}

let samples = normalized["videoFrameSamples"] as? [[String: Any]] ?? []
guard samples.count == 1,
      samples[0]["timestamp"] as? String == "00:12",
      samples[0]["image"] as? String == "data:image/jpeg;base64,abc123"
else {
    fatalError("video frame samples were not preserved")
}

print("PanelStateWriter video normalization smoke test passed")
```

- [ ] **Step 2: Run the Swift smoke test and verify it fails**

Run:

```bash
swiftc -D SAFARAI_PANEL_STATE_WRITER_TEST tests/panel-state-writer.test.swift "safarai/safarai Extension/PanelStateWriter.swift" "safarai/safarai Extension/SharedContainer.swift" -o /tmp/safarai-panel-state-writer-test && /tmp/safarai-panel-state-writer-test
```

Expected: FAIL because `PanelStateWriter.normalizeContextForTest` does not exist.

- [ ] **Step 3: Expose normalization only for local smoke tests**

Modify `safarai/safarai Extension/PanelStateWriter.swift` inside `enum PanelStateWriter`, immediately before the private `normalizeContext(_:)` function:

```swift
#if SAFARAI_PANEL_STATE_WRITER_TEST
    static func normalizeContextForTest(_ context: [String: Any]) -> [String: Any] {
        normalizeContext(context) ?? [:]
    }
#endif
```

The surrounding code should read:

```swift
#if SAFARAI_PANEL_STATE_WRITER_TEST
    static func normalizeContextForTest(_ context: [String: Any]) -> [String: Any] {
        normalizeContext(context) ?? [:]
    }
#endif

    private static func normalizeContext(_ context: [String: Any]?) -> [String: Any]? {
        guard let context else {
            return nil
        }
```

- [ ] **Step 4: Run the Swift smoke test and verify it passes**

Run:

```bash
swiftc -D SAFARAI_PANEL_STATE_WRITER_TEST tests/panel-state-writer.test.swift "safarai/safarai Extension/PanelStateWriter.swift" "safarai/safarai Extension/SharedContainer.swift" -o /tmp/safarai-panel-state-writer-test && /tmp/safarai-panel-state-writer-test
```

Expected: PASS and print `PanelStateWriter video normalization smoke test passed`.

- [ ] **Step 5: Run all JS tests to catch unrelated regressions**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add tests/panel-state-writer.test.swift "safarai/safarai Extension/PanelStateWriter.swift"
git commit -m "test: preserve video fields in panel state"
```

---

### Task 4: Align Text Prompt Requirements Across Providers

**Files:**
- Modify: `safarai/safarai/CodexResponseService.swift`
- Modify: `safarai/safarai/ZedResponseService.swift`
- Inspect: `safarai/safarai/OpenAICompatibleResponseService.swift`

- [ ] **Step 1: Use OpenAI-compatible prompt requirements as the canonical reference**

Inspect the current `appendTaskIntent(_:context:to:)` in `safarai/safarai/OpenAICompatibleResponseService.swift`. Keep these requirements intact:

```swift
- 用 Markdown 输出三个部分：## 整体概览、## 时间线要点、## 适合快速记住的结论。
- 时间线要点必须引用可用时间戳，格式如 00:00-02:15：要点。
- 融合页面结构、视频标题/描述、章节/重要时刻、评论高信号、字幕和采样画面；优先使用语义密度高的实体、事件、时间和地点。
- 评论区只作为“集体注意力信号”，不要把评论当成视频事实，除非视频描述/字幕/画面也支持。
- 如果提供了 video_frame_samples，也要结合画面 OCR、人物/场景/镜头变化总结可见信息；时间线可引用采样帧附近的时间戳。
- 不要编造字幕或页面中没有的信息。
- 如果 video_transcript 为空但 video_frame_samples 不为空，必须先写“未检测到可用时间戳字幕，以下基于采样画面和页面信息总结”。
- 如果 video_transcript 与 video_frame_samples 都为空，必须先写“未检测到可用时间戳字幕”，再仅基于标题、简介、可见页面信息做简短总结。
```

- [ ] **Step 2: Update Codex text prompt requirements**

Modify `appendTaskIntent(_:context:to:)` in `safarai/safarai/CodexResponseService.swift`.

Replace the whole function body with:

```swift
    private func appendTaskIntent(_ taskIntent: String, context: PanelContextSnapshot?, to sections: inout [String]) {
        guard taskIntent == "summarize_video" else { return }
        let transcriptCount = context?.videoTranscript?.count ?? 0
        let frameSampleCount = context?.videoFrameSamples?.count ?? 0
        sections.append("""
task_intent: summarize_video
output_requirements:
	- 用 Markdown 输出三个部分：## 整体概览、## 时间线要点、## 适合快速记住的结论。
	- 时间线要点必须引用可用时间戳，格式如 00:00-02:15：要点。
	- 融合页面结构、视频标题/描述、章节/重要时刻、评论高信号和字幕；优先使用语义密度高的实体、事件、时间和地点。
	- 评论区只作为“集体注意力信号”，不要把评论当成视频事实，除非视频描述或字幕也支持。
	- 如果提示中出现 video_frame_sample_count，只能把它当作采样状态信号；当前 Codex 请求不附带图片内容，不要声称看到了采样画面。
	- 不要编造字幕或页面中没有的信息。
	- 如果 video_transcript 为空，必须先写“未检测到可用时间戳字幕”，再仅基于标题、简介、可见页面信息做简短总结。
video_transcript_count: \(transcriptCount)
video_frame_sample_count: \(frameSampleCount)
""")
    }
```

- [ ] **Step 3: Update Zed text prompt requirements**

Modify `appendTaskIntent(_:context:to:)` in `safarai/safarai/ZedResponseService.swift`.

Replace the whole function body with:

```swift
    private func appendTaskIntent(_ taskIntent: String, context: PanelContextSnapshot?, to sections: inout [String]) {
        guard taskIntent == "summarize_video" else { return }
        let transcriptCount = context?.videoTranscript?.count ?? 0
        let frameSampleCount = context?.videoFrameSamples?.count ?? 0
        sections.append("""
task_intent: summarize_video
output_requirements:
	- 用 Markdown 输出三个部分：## 整体概览、## 时间线要点、## 适合快速记住的结论。
	- 时间线要点必须引用可用时间戳，格式如 00:00-02:15：要点。
	- 融合页面结构、视频标题/描述、章节/重要时刻、评论高信号和字幕；优先使用语义密度高的实体、事件、时间和地点。
	- 评论区只作为“集体注意力信号”，不要把评论当成视频事实，除非视频描述或字幕也支持。
	- 如果提示中出现 video_frame_sample_count，只能把它当作采样状态信号；当前 Zed 请求不附带图片内容，不要声称看到了采样画面。
	- 不要编造字幕或页面中没有的信息。
	- 如果 video_transcript 为空，必须先写“未检测到可用时间戳字幕”，再仅基于标题、简介、可见页面信息做简短总结。
video_transcript_count: \(transcriptCount)
video_frame_sample_count: \(frameSampleCount)
""")
    }
```

- [ ] **Step 4: Confirm no OpenAI-compatible multimodal path was removed**

Run:

```bash
rg -n "image_url|video_frame_sample_count|videoFrameSamples|buildUserMessageContent" safarai/safarai/OpenAICompatibleResponseService.swift
```

Expected: output includes `buildUserMessageContent`, `videoFrameSamples`, `image_url`, and `video_frame_sample_count`.

- [ ] **Step 5: Run JS tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS. These tests do not compile Swift, but they catch accidental JS regressions before committing.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add safarai/safarai/CodexResponseService.swift safarai/safarai/ZedResponseService.swift
git commit -m "feat: align video summary prompt requirements"
```

---

### Task 5: Add Manual Safari Verification Checklist

**Files:**
- Create: `docs/superpowers/manual-tests/video-summary-mvp.md`

- [ ] **Step 1: Create the manual checklist**

Create `docs/superpowers/manual-tests/video-summary-mvp.md`:

```markdown
# Video Summary MVP Manual Safari Checklist

Date: 2026-05-23

## Setup

- Build and run the Safarai macOS app from Xcode.
- Enable the Safarai Safari extension.
- Open the Safarai panel.
- Select a configured provider. Use OpenAI-compatible for the frame-sampling scenario when available.

## Scenarios

### YouTube With Captions

- Open a YouTube watch page with visible or available captions.
- Confirm the `视频总结` button appears.
- Click `视频总结`.
- Expected: response includes `## 整体概览`, `## 时间线要点`, and `## 适合快速记住的结论`.
- Expected: timeline points cite timestamps such as `00:00` or `00:00-02:15`.
- Expected: comments are not treated as verified facts unless supported by video evidence.

### YouTube With Sparse Or Unavailable Captions

- Open a YouTube video where captions are unavailable or not detected.
- Confirm the `视频总结` button appears.
- Click `视频总结`.
- Expected: response starts by saying no usable timestamped transcript was detected.
- Expected: response only summarizes from title, description, visible page text, chapters, attention signals, or sampled frames when available.
- Expected: response does not claim to have watched the full video.

### Bilibili Video Page

- Open a Bilibili video page.
- Confirm the `视频总结` button appears.
- Click `视频总结`.
- Expected: title, UP name, description, or visible subtitles are reflected when available.
- Expected: missing subtitle data produces an honest degraded summary.

### Generic Page With Primary Video

- Open a page that contains one large primary `<video>` element.
- Confirm the `视频总结` button appears.
- Click `视频总结`.
- Expected: if captions are unavailable, the response states the limitation and summarizes only visible page information.

### Non-Video Page

- Open a regular article, GitHub page, or mail page with no primary video.
- Expected: `视频总结` button is hidden.
- Expected: normal page Q&A buttons and composer behavior still work.

### Detached Page Context

- Open a video page and confirm the context URL is shown.
- Detach or cancel the page association from the panel.
- Send a video summary request only if the UI still allows it.
- Expected: Safarai does not silently summarize the detached page as if it were active context.
```

- [ ] **Step 2: Commit Task 5**

Run:

```bash
git add docs/superpowers/manual-tests/video-summary-mvp.md
git commit -m "docs: add video summary manual checklist"
```

---

### Task 6: Final Verification And Handoff

**Files:**
- Inspect: all files changed in Tasks 1-5

- [ ] **Step 1: Run all JS tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the Swift smoke test**

Run:

```bash
swiftc -D SAFARAI_PANEL_STATE_WRITER_TEST tests/panel-state-writer.test.swift "safarai/safarai Extension/PanelStateWriter.swift" "safarai/safarai Extension/SharedContainer.swift" -o /tmp/safarai-panel-state-writer-test && /tmp/safarai-panel-state-writer-test
```

Expected: PASS and print `PanelStateWriter video normalization smoke test passed`.

- [ ] **Step 3: Review changed files**

Run:

```bash
git diff --stat HEAD~5..HEAD
git status --short --branch
```

Expected: diff stat lists the new helper, tests, prompt updates, and manual checklist. Working tree is clean.

- [ ] **Step 4: Record manual Safari results**

Run through `docs/superpowers/manual-tests/video-summary-mvp.md`. If any scenario cannot be run on the current machine, add a short note to the PR description rather than changing runtime code.

- [ ] **Step 5: Push the branch**

Run:

```bash
git push origin feature/wwy_dev
```

Expected: branch pushes successfully.

---

## Self-Review

- Spec coverage: Tasks 1 and 2 cover entry-point visibility and video context detection. Task 3 covers shared-state field preservation. Task 4 covers provider prompt consistency and OpenAI-compatible multimodal preservation. Task 5 covers manual Safari verification. Task 6 covers final automated and manual handoff.
- Placeholder scan: The plan contains no incomplete sections or vague implementation requests.
- Type consistency: The plan uses the existing `PanelContextSnapshot.videoFrameSamples`, `metadata.hasPrimaryVideo`, `metadata.pageKind`, `videoTranscript`, `videoRAGSummary`, and `taskIntent == "summarize_video"` names consistently.
