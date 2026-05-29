let activeWriteTarget = null;
let lastKnownURL = window.location.href;
let interactiveTargetIndex = new Map();
let latestInteractiveTargets = [];
let lastStableSelection = "";
let lastStableSelectionURL = window.location.href;
let contextSyncTimer = null;
let bootstrapSyncToken = 0;
let bootstrapSyncTimers = [];
let platformTranscriptCacheURL = "";
let platformTranscriptCache = [];
let platformTranscriptCacheUpdatedAt = 0;
const sharedModulesPromise = loadSharedModules();
const BOOTSTRAP_SYNC_DELAYS = [0, 180, 600, 1400, 2600, 4200];
const MAX_PLATFORM_TRANSCRIPT_SEGMENTS = 240;
const MAX_PLATFORM_TRANSCRIPT_TEXT_LENGTH = 360;
const PLATFORM_TRANSCRIPT_EMPTY_RETRY_MS = 5000;
const VIDEO_FRAME_SAMPLE_LIMIT = 8;
const VIDEO_FRAME_SAMPLE_SETTLE_MS = 950;

patchHistoryMethods();
observeVisualChanges();
observeSystemAppearance();
installSafariAppExtensionBridge();

scheduleBootstrapSync("startup");

browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "content:get-page-context":
      return handleGetPageContext();
    case "content:prepare-focused-input":
      return handlePrepareFocusedInput();
    case "content:apply-draft":
      return handleApplyDraft(message.payload?.draft);
    case "content:highlight-target":
      return handleInteractiveTargetCommand("highlight", message.payload);
    case "content:focus-target":
      return handleInteractiveTargetCommand("focus", message.payload);
    case "content:scroll-to-target":
      return handleInteractiveTargetCommand("scroll", message.payload);
    case "content:trigger-sync":
      scheduleBootstrapSync("background-trigger");
      return handleGetPageContext();
    case "content:prepare-video-frame-sample":
      return handlePrepareVideoFrameSample(message.payload);
    default:
      return undefined;
  }
});

document.addEventListener("selectionchange", () => {
  rememberCurrentSelection();
  syncStableSelection();
  queueContextSync();
});

document.addEventListener("mouseup", () => {
  rememberCurrentSelection();
  syncStableSelection();
});

document.addEventListener("keyup", () => {
  rememberCurrentSelection();
  syncStableSelection();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    scheduleBootstrapSync("visibilitychange");
  }
});

window.addEventListener("focus", () => {
  scheduleBootstrapSync("focus");
});

window.addEventListener("popstate", () => {
  scheduleBootstrapSync("popstate");
});

window.addEventListener("hashchange", () => {
  scheduleBootstrapSync("hashchange");
});

document.addEventListener("yt-navigate-finish", () => {
  scheduleBootstrapSync("yt-navigate-finish");
});

document.addEventListener("DOMContentLoaded", () => {
  scheduleBootstrapSync("domcontentloaded");
});

window.addEventListener("load", () => {
  scheduleBootstrapSync("load");
});

window.addEventListener("pageshow", () => {
  scheduleBootstrapSync("pageshow");
});

setInterval(() => {
  if (window.location.href !== lastKnownURL) {
    lastKnownURL = window.location.href;
    lastStableSelection = "";
    lastStableSelectionURL = window.location.href;
    scheduleBootstrapSync("url-poll");
  }
}, 1000);

function handleGetPageContext() {
  return (async () => {
    try {
      const context = await extractContextSnapshot();
      return createSuccessResponseLite({
        context,
      });
    } catch (error) {
      return createSuccessResponseLite({
        context: buildLightweightPageContext(),
        degraded: true,
        warning: `页面解析已降级：${error.message}`,
      });
    }
  })();
}

function handlePrepareFocusedInput() {
  return (async () => {
    const {
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      highlightElement,
      isWritableElement,
      resolveWritableTarget,
    } = await sharedModulesPromise;
    const pageContext = await extractContextSnapshot();
    const target = resolveWritableTarget(document, document.activeElement, {
      site: pageContext.site,
      ...pageContext.metadata,
    });
    if (!isWritableElement(target)) {
      return createErrorResponse("focused_input_missing", "请先点击 GitHub 评论输入框");
    }

    activeWriteTarget = target;
    highlightElement(target);

    return createSuccessResponse({
      target: describeWriteTarget(target, pageContext.metadata),
    });
  })();
}

function handleApplyDraft(draft) {
  return (async () => {
    const {
      applyDraftToElement,
      clearHighlight,
      copyDraftFallback,
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      isWritableElement,
      resolveWritableTarget,
    } = await sharedModulesPromise;
    const pageContext = await extractContextSnapshot();
    const target = resolveWritableTarget(
      document,
      activeWriteTarget && document.contains(activeWriteTarget)
        ? activeWriteTarget
        : document.activeElement,
      {
        site: pageContext.site,
        ...pageContext.metadata,
      }
    );

    if (!isWritableElement(target)) {
      const copied = copyDraftFallback(window, document, draft);
      if (copied) {
        clearHighlight(document);
        activeWriteTarget = null;
        return createSuccessResponse({
          mode: "clipboard",
          answer: "输入目标已丢失，草稿已降级复制到剪贴板，未自动提交。",
        });
      }

      return createErrorResponse("write_target_lost", "输入目标已丢失，请重新点击输入框并生成草稿");
    }

    const applied = applyDraftToElement(target, draft ?? "");
    if (!applied) {
      const copied = copyDraftFallback(window, document, draft);
      if (copied) {
        clearHighlight(document);
        activeWriteTarget = null;
        return createSuccessResponse({
          mode: "clipboard",
          answer: "当前输入框写入失败，草稿已降级复制到剪贴板，未自动提交。",
        });
      }

      return createErrorResponse("write_failed", "当前输入框写入失败");
    }

    clearHighlight(document);
    activeWriteTarget = target;
    const latestContext = await extractContextSnapshot();

    return createSuccessResponse({
      mode: "page",
      answer: "草稿已写入页面，未自动提交。",
      target: describeWriteTarget(target, latestContext.metadata),
    });
  })();
}

function handleInteractiveTargetCommand(action, payload = {}) {
  return (async () => {
    const {
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      highlightElement,
    } = await sharedModulesPromise;
    const target = resolveInteractiveTarget(payload.targetId, payload.selectorHint);
    if (!target) {
      return createErrorResponse("target_not_found", "目标元素不存在或已失效");
    }

    if (action === "highlight") {
      highlightElement(target);
    } else if (action === "focus") {
      target.focus?.();
      highlightElement(target);
    } else if (action === "scroll") {
      target.scrollIntoView?.({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
      highlightElement(target);
    }

    const latestContext = await extractContextSnapshot();
    return createSuccessResponse({
      target: {
        id: payload.targetId || "",
        description:
          payload.label ||
          describeWriteTarget(target, latestContext.metadata)?.description ||
          "",
      },
    });
  })();
}

function handlePrepareVideoFrameSample(payload = {}) {
  return (async () => {
    const video = findPrimaryVideoElement();
    if (!video) {
      return createSuccessResponseLite({
        prepared: false,
        reason: "video_not_found",
      });
    }

    const duration = normalizePositiveNumber(video.duration);
    const requestedTime = normalizePositiveNumber(payload.timeSeconds);
    const targetTime = clampVideoSampleTime(requestedTime ?? 0, duration);
    const wasPaused = video.paused;
    const originalMuted = video.muted;

    try {
      video.pause?.();
      video.muted = true;
      if (Number.isFinite(targetTime)) {
        await seekVideoTo(video, targetTime);
      }
      await waitForVideoFrame(video);
      video.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
      await delay(VIDEO_FRAME_SAMPLE_SETTLE_MS);
      return createSuccessResponseLite({
        prepared: true,
        timestamp: formatTimestamp(video.currentTime || targetTime || 0),
        timeSeconds: Math.round(video.currentTime || targetTime || 0),
        durationSeconds: duration == null ? null : Math.round(duration),
        wasPaused,
      });
    } catch (error) {
      return createSuccessResponseLite({
        prepared: false,
        reason: error?.message || String(error),
      });
    } finally {
      video.muted = originalMuted;
      if (!wasPaused) {
        video.play?.().catch?.(() => {});
      }
    }
  })();
}

function queueContextSync() {
  if (contextSyncTimer) {
    clearTimeout(contextSyncTimer);
  }

  contextSyncTimer = setTimeout(() => {
    contextSyncTimer = null;
    syncContextNow("queued").catch(() => {});
  }, 120);
}

async function syncContextNow(reason = "") {
  try {
    lastKnownURL = window.location.href;
    const context = await extractContextSnapshot();
    context.metadata = {
      ...(context.metadata ?? {}),
      pageContextSyncReason: String(reason || ""),
    };
    await browser.runtime.sendMessage({
      type: "content:page-updated",
      payload: { context },
    }).catch(() => {});
  } catch {
    // Ignore transient DOM read failures during page bootstrap.
  }
}

function installSafariAppExtensionBridge() {
  const safariSelf = globalThis.safari?.self;
  if (!safariSelf?.addEventListener) {
    return;
  }

  safariSelf.addEventListener("message", (event) => {
    const name = event?.name || event?.message?.name || "";
    if (name === "refresh-active-page-context") {
      scheduleBootstrapSync("containing-app-request");
      syncContextNow("containing-app-request").catch(() => {});
    } else if (name === "sample-active-video-frames") {
      browser.runtime.sendMessage({
        type: "content:sample-video-frames",
      }).catch(() => {});
    }
  });
}

function scheduleBootstrapSync(_reason = "") {
  bootstrapSyncToken += 1;
  const activeToken = bootstrapSyncToken;
  clearBootstrapSyncTimers();

  bootstrapSyncTimers = BOOTSTRAP_SYNC_DELAYS.map((delay) =>
    setTimeout(() => {
      if (activeToken !== bootstrapSyncToken) {
        return;
      }
      queueContextSync();
    }, delay)
  );
}

function clearBootstrapSyncTimers() {
  for (const timer of bootstrapSyncTimers) {
    clearTimeout(timer);
  }
  bootstrapSyncTimers = [];
}

function syncStableSelection() {
  const selection = String(lastStableSelection || "").trim();
  if (!selection) {
    return;
  }

  browser.runtime.sendMessage({
    type: "content:selection-updated",
    payload: {
      url: window.location.href,
      selection,
    },
  }).catch(() => {});
}

function patchHistoryMethods() {
  const wrap = (methodName) => {
    const original = window.history[methodName];
    if (typeof original !== "function") {
      return;
    }

    window.history[methodName] = function (...args) {
      const result = original.apply(this, args);
      scheduleBootstrapSync(`history:${methodName}`);
      return result;
    };
  };

  wrap("pushState");
  wrap("replaceState");
}

async function extractContextSnapshot() {
  let context;
  try {
    const { extractPageContext } = await sharedModulesPromise;
    context = extractPageContext(window, document);
  } catch {
    context = buildLightweightPageContext();
  }
  context = await enrichContextWithPlatformTranscript(context);
  const liveSelection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const selection = String(context.selection || "").trim();
  if (selection) {
    lastStableSelection = selection;
    lastStableSelectionURL = window.location.href;
  } else if (
    lastStableSelection &&
    lastStableSelectionURL === window.location.href
  ) {
    context.selection = lastStableSelection;
  } else if (lastStableSelectionURL !== window.location.href) {
    lastStableSelection = "";
    lastStableSelectionURL = window.location.href;
  }
  interactiveTargetIndex = context.__interactiveTargetIndex ?? new Map();
  latestInteractiveTargets = Array.isArray(context.interactiveTargets)
    ? context.interactiveTargets
    : [];
  context.debugSelection = {
    contentLiveSelection: truncateDebugValue(liveSelection),
    contentStableSelection: truncateDebugValue(lastStableSelection),
    contentSelectionURL: truncateDebugValue(lastStableSelectionURL),
  };
  return context;
}

function findPrimaryVideoElement() {
  const videos = Array.from(document.querySelectorAll?.("video") || []);
  if (!videos.length) {
    return null;
  }
  return videos
    .map((video, index) => {
      const rect = video.getBoundingClientRect?.() || { width: 0, height: 0 };
      const area = Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0);
      return { video, index, area };
    })
    .filter((item) => item.area > 0)
    .sort((left, right) => right.area - left.area || left.index - right.index)[0]?.video ?? videos[0];
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clampVideoSampleTime(value, duration) {
  const time = normalizePositiveNumber(value) ?? 0;
  if (duration == null || duration <= 0) {
    return time;
  }
  return Math.min(Math.max(0.1, time), Math.max(0.1, duration - 0.4));
}

function seekVideoTo(video, timeSeconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("video_seek_failed"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener?.("seeked", finish);
      video.removeEventListener?.("error", fail);
    };
    const timeout = setTimeout(finish, 1800);
    video.addEventListener?.("seeked", finish, { once: true });
    video.addEventListener?.("error", fail, { once: true });
    try {
      video.currentTime = timeSeconds;
      if (Math.abs((video.currentTime || 0) - timeSeconds) < 0.2) {
        setTimeout(finish, 120);
      }
    } catch {
      fail();
    }
  });
}

function waitForVideoFrame(video) {
  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 900);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  return delay(600);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSharedModules() {
  const runtimeGetURL =
    typeof browser?.runtime?.getURL === "function"
      ? browser.runtime.getURL.bind(browser.runtime)
      : (path) => path;
  const [protocolModule, pageContextModule, writeTargetModule] = await Promise.all([
    import(runtimeGetURL("protocol.js")),
    import(runtimeGetURL("page-context.js")),
    import(runtimeGetURL("write-target.js")),
  ]);

  return {
    ...protocolModule,
    ...pageContextModule,
    ...writeTargetModule,
  };
}

function createSuccessResponseLite(payload = {}) {
  return {
    ok: true,
    payload,
  };
}

async function enrichContextWithPlatformTranscript(context) {
  if (!shouldFetchPlatformTranscript(context)) {
    return context;
  }

  const transcript = await loadPlatformTranscript(context);
  if (!transcript.length) {
    context.metadata = {
      ...(context.metadata ?? {}),
      platformTranscriptStatus:
        context.metadata?.platformTranscriptStatus || "unavailable",
    };
    return context;
  }

  context.videoTranscript = transcript;
  context.metadata = {
    ...(context.metadata ?? {}),
    videoTranscriptCount: String(transcript.length),
    videoTranscriptSource: transcript[0]?.source || "platform_caption",
    hasTranscript: "true",
    platformTranscriptStatus: "loaded",
  };
  context.articleText = mergeTranscriptIntoArticleText(context.articleText, transcript);
  return context;
}

function shouldFetchPlatformTranscript(context) {
  const metadata = context?.metadata ?? {};
  const transcript = Array.isArray(context?.videoTranscript) ? context.videoTranscript : [];
  const pageKind = String(metadata.pageKind || "");
  const site = String(context?.site || "");
  if (transcript.length >= 3) {
    return false;
  }
  return (
    pageKind === "youtube_video" ||
    pageKind === "bilibili_video" ||
    (metadata.hasPrimaryVideo === "true" && (site === "youtube" || site === "bilibili"))
  );
}

async function loadPlatformTranscript(context) {
  const url = String(context?.url || window.location.href || "");
  const cacheAge = Date.now() - platformTranscriptCacheUpdatedAt;
  if (platformTranscriptCacheURL === url && platformTranscriptCache.length) {
    return platformTranscriptCache;
  }
  if (
    platformTranscriptCacheURL === url &&
    !platformTranscriptCache.length &&
    cacheAge >= 0 &&
    cacheAge < PLATFORM_TRANSCRIPT_EMPTY_RETRY_MS
  ) {
    return [];
  }

  platformTranscriptCacheURL = url;
  platformTranscriptCache = [];
  platformTranscriptCacheUpdatedAt = Date.now();

  const site = String(context?.site || "");
  const transcript =
    site === "youtube"
      ? await fetchYouTubeTranscript()
      : site === "bilibili"
        ? await fetchBilibiliTranscript()
        : [];

  platformTranscriptCache = normalizeTranscriptSegments(transcript);
  platformTranscriptCacheUpdatedAt = Date.now();
  return platformTranscriptCache;
}

function mergeTranscriptIntoArticleText(articleText, transcript) {
  const baseText = String(articleText || "").trim();
  const transcriptText = transcript
    .slice(0, 80)
    .map((segment) => `${segment.timestamp} ${segment.text}`)
    .join("\n");
  if (!transcriptText) {
    return baseText;
  }
  if (baseText.includes("video_transcript_or_visible_subtitles:")) {
    return baseText;
  }
  return `${baseText}\n\nvideo_transcript_or_visible_subtitles:\n${transcriptText}`.trim().slice(0, 12000);
}

async function fetchYouTubeTranscript() {
  const viaInnerTube = await fetchYouTubeTranscriptViaInnerTube();
  if (viaInnerTube.length) {
    return viaInnerTube;
  }

  // Legacy fallback: timedtext baseUrl (now usually signature/POT-gated, kept for older cases).
  const playerResponse = findYouTubePlayerResponse();
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const sortedTracks = [...tracks].sort(compareYouTubeCaptionTracks);

  for (const track of sortedTracks) {
    const baseURL = String(track?.baseUrl || "");
    if (!baseURL) {
      continue;
    }
    const url = withYouTubeTranscriptFormat(baseURL);
    try {
      const text = await fetchTranscriptText(url);
      const transcript = parseYouTubeTranscriptPayload(text);
      if (transcript.length) {
        return transcript.map((segment) => ({
          ...segment,
          source: track.kind === "asr" ? "youtube_auto_caption" : "youtube_caption",
        }));
      }
    } catch {
      // Try the next caption track.
    }
  }

  return [];
}

// InnerTube get_transcript: the current reliable path. Runs same-origin from the
// content script, so it uses the page session and needs no POT token or proxy.
const YOUTUBE_INNERTUBE_FALLBACK_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const YOUTUBE_INNERTUBE_FALLBACK_VERSION = "2.20240826.01.00";

async function fetchYouTubeTranscriptViaInnerTube() {
  const videoId = getYouTubeVideoId();
  if (!videoId) {
    return [];
  }
  try {
    const { key, clientVersion } = readYouTubeInnerTubeConfig();
    const context = {
      client: {
        clientName: "WEB",
        clientVersion,
        hl: navigator.language?.slice(0, 2) || "en",
        gl: "US",
      },
    };

    // getTranscriptEndpoint params live in ytInitialData; fall back to a player POST.
    let params = findKeyDeep(scrapeYouTubeGlobal("ytInitialData"), "getTranscriptEndpoint")?.params;
    if (!params) {
      const player = await youtubeInnerTubePost("player", key, { context, videoId });
      params = findKeyDeep(player, "getTranscriptEndpoint")?.params;
    }
    if (!params) {
      return [];
    }

    const transcriptResponse = await youtubeInnerTubePost("get_transcript", key, { context, params });
    const segments = findKeyDeep(transcriptResponse, "initialSegments");
    if (!Array.isArray(segments)) {
      return [];
    }
    return segments
      .map((entry) => {
        const seg = entry?.transcriptSegmentRenderer;
        if (!seg) {
          return null;
        }
        const text = Array.isArray(seg.snippet?.runs)
          ? seg.snippet.runs.map((run) => run?.text || "").join("")
          : seg.snippet?.simpleText || "";
        return makeTranscriptSegmentFromMilliseconds(
          seg.startMs,
          seg.endMs == null ? null : Number(seg.endMs),
          text,
          "youtube_caption"
        );
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getYouTubeVideoId() {
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("v");
    if (v) {
      return v;
    }
    const match = url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function readYouTubeInnerTubeConfig() {
  const html = document.documentElement?.innerHTML || "";
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || YOUTUBE_INNERTUBE_FALLBACK_KEY;
  const clientVersion =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion":"([\d.]+)"/)?.[1] ||
    YOUTUBE_INNERTUBE_FALLBACK_VERSION;
  return { key, clientVersion };
}

async function youtubeInnerTubePost(endpoint, key, body) {
  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(key)}&prettyPrint=false`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(`innertube ${endpoint} ${response.status}`);
  }
  return response.json();
}

function scrapeYouTubeGlobal(marker) {
  const direct = globalThis[marker];
  if (direct && typeof direct === "object") {
    return direct;
  }
  for (const script of Array.from(document.scripts || [])) {
    const text = script.textContent || "";
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const jsonText = extractBalancedJSON(text, text.indexOf("{", text.indexOf("=", markerIndex)));
    if (!jsonText) {
      continue;
    }
    try {
      return JSON.parse(jsonText);
    } catch {
      // Continue scanning scripts.
    }
  }
  return null;
}

function findKeyDeep(value, targetKey, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (!Array.isArray(value) && value[targetKey] !== undefined) {
    return value[targetKey];
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findKeyDeep(child, targetKey, seen);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function findYouTubePlayerResponse() {
  const direct = globalThis.ytInitialPlayerResponse;
  if (direct?.captions) {
    return direct;
  }

  for (const script of Array.from(document.scripts || [])) {
    const text = script.textContent || "";
    const marker = "ytInitialPlayerResponse";
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const equalsIndex = text.indexOf("=", markerIndex);
    if (equalsIndex === -1) {
      continue;
    }
    const jsonText = extractBalancedJSON(text, text.indexOf("{", equalsIndex));
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed?.captions) {
        return parsed;
      }
    } catch {
      // Continue scanning scripts.
    }
  }

  return null;
}

function compareYouTubeCaptionTracks(left, right) {
  const leftScore = scoreYouTubeCaptionTrack(left);
  const rightScore = scoreYouTubeCaptionTrack(right);
  return rightScore - leftScore;
}

function scoreYouTubeCaptionTrack(track) {
  const language = String(track?.languageCode || "").toLowerCase();
  const name = JSON.stringify(track?.name || {}).toLowerCase();
  let score = 0;
  if (language.startsWith(navigator.language?.slice(0, 2).toLowerCase() || "")) score += 30;
  if (language.startsWith("zh")) score += 20;
  if (language.startsWith("en")) score += 15;
  if (track?.kind !== "asr") score += 10;
  if (name.includes("default")) score += 5;
  return score;
}

function withYouTubeTranscriptFormat(baseURL) {
  try {
    const url = new URL(baseURL);
    url.searchParams.set("fmt", "json3");
    return url.toString();
  } catch {
    return baseURL.includes("fmt=")
      ? baseURL
      : `${baseURL}${baseURL.includes("?") ? "&" : "?"}fmt=json3`;
  }
}

function parseYouTubeTranscriptPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }

  try {
    const json = JSON.parse(trimmed);
    const events = Array.isArray(json?.events) ? json.events : [];
    return events
      .map((event) => {
        const text = Array.isArray(event.segs)
          ? event.segs.map((seg) => seg?.utf8 || "").join("")
          : "";
        return makeTranscriptSegmentFromMilliseconds(
          event.tStartMs,
          event.dDurationMs == null ? null : Number(event.tStartMs || 0) + Number(event.dDurationMs || 0),
          text,
          "youtube_caption"
        );
      })
      .filter(Boolean);
  } catch {
    return parseYouTubeTranscriptXML(trimmed);
  }
}

function parseYouTubeTranscriptXML(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/xml");
  return Array.from(doc.querySelectorAll("text"))
    .map((node) =>
      makeTranscriptSegment(
        Number.parseFloat(node.getAttribute("start") || "0"),
        node.getAttribute("dur") == null
          ? null
          : Number.parseFloat(node.getAttribute("start") || "0") + Number.parseFloat(node.getAttribute("dur") || "0"),
        node.textContent || "",
        "youtube_caption"
      )
    )
    .filter(Boolean);
}

async function fetchBilibiliTranscript() {
  const subtitleURLs = [];
  try {
    const listURL = await getBilibiliSubtitleListURL();
    if (listURL) {
      const data = JSON.parse(await fetchTranscriptText(listURL));
      for (const sub of data?.data?.subtitle?.subtitles || []) {
        if (sub?.subtitle_url) {
          subtitleURLs.push(new URL(sub.subtitle_url, window.location.href).toString());
        }
      }
    }
  } catch {
    // Fall back to DOM-scraped subtitle URLs below.
  }
  for (const url of findBilibiliSubtitleURLs()) {
    subtitleURLs.push(url);
  }

  for (const url of subtitleURLs) {
    try {
      const payload = JSON.parse(await fetchTranscriptText(url));
      const items = Array.isArray(payload?.body) ? payload.body : [];
      const transcript = items
        .map((item) =>
          makeTranscriptSegment(
            Number(item.from ?? item.start ?? 0),
            item.to == null ? null : Number(item.to),
            item.content || item.text || "",
            "bilibili_subtitle_json"
          )
        )
        .filter(Boolean);
      if (transcript.length) {
        return transcript;
      }
    } catch {
      // Try the next subtitle URL.
    }
  }
  return [];
}

// The Bilibili subtitle list is only available behind the WBI-signed player endpoint.
let bilibiliWbiMixinKeyCache = "";

async function getBilibiliSubtitleListURL() {
  const state = scrapeYouTubeGlobal("__INITIAL_STATE__"); // generic page-JSON scraper, reused
  const videoData = state?.videoData || findKeyDeep(state, "videoData") || {};
  const aid = videoData.aid || state?.aid;
  const bvid = videoData.bvid || state?.bvid;
  const cid = videoData.cid || findKeyDeep(state, "cid");
  if (!cid || (!aid && !bvid)) {
    return "";
  }
  const mixinKey = await getBilibiliWbiMixinKey();
  if (!mixinKey) {
    return "";
  }
  const params = { cid: String(cid) };
  if (aid) params.aid = String(aid);
  if (bvid) params.bvid = String(bvid);
  return `https://api.bilibili.com/x/player/wbi/v2?${wbiSignedQuery(params, mixinKey)}`;
}

async function getBilibiliWbiMixinKey() {
  if (bilibiliWbiMixinKeyCache) {
    return bilibiliWbiMixinKeyCache;
  }
  try {
    const nav = JSON.parse(await fetchTranscriptText("https://api.bilibili.com/x/web-interface/nav"));
    const imgURL = String(nav?.data?.wbi_img?.img_url || "");
    const subURL = String(nav?.data?.wbi_img?.sub_url || "");
    const raw =
      imgURL.slice(imgURL.lastIndexOf("/") + 1).split(".")[0] +
      subURL.slice(subURL.lastIndexOf("/") + 1).split(".")[0];
    const table = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
    bilibiliWbiMixinKeyCache = table.map((i) => raw[i] || "").join("").slice(0, 32);
  } catch {
    bilibiliWbiMixinKeyCache = "";
  }
  return bilibiliWbiMixinKeyCache;
}

function wbiSignedQuery(params, mixinKey) {
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function md5(str) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / 2 ** (8 * i)) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
    }
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (n) => Array.from({ length: 4 }, (_, i) => ((n >> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

async function fetchTranscriptText(url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (response.ok) {
      return response.text();
    }
  } catch {
    // Fall back to the extension background request below.
  }

  const response = await browser.runtime.sendMessage({
    type: "content:fetch-transcript-url",
    payload: { url },
  });
  if (!response?.ok) {
    throw new Error(response?.error?.message || "transcript fetch failed");
  }
  return String(response.payload?.text || "");
}

function findBilibiliSubtitleURLs() {
  const urls = new Set();
  const addSubtitleURL = (value) => {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }
    try {
      urls.add(new URL(text, window.location.href).toString());
    } catch {
      // Ignore malformed subtitle URLs.
    }
  };

  collectSubtitleURLs(globalThis.__INITIAL_STATE__, addSubtitleURL);
  collectSubtitleURLs(globalThis.__playinfo__, addSubtitleURL);

  for (const script of Array.from(document.scripts || [])) {
    const text = script.textContent || "";
    if (!text.includes("subtitle")) {
      continue;
    }
    for (const match of text.matchAll(/"subtitle_url"\s*:\s*"([^"]+)"/g)) {
      addSubtitleURL(match[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/"));
    }
  }

  return Array.from(urls);
}

function collectSubtitleURLs(value, addSubtitleURL, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSubtitleURLs(item, addSubtitleURL, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "subtitle_url" || key === "subtitleUrl") {
      addSubtitleURL(child);
    } else {
      collectSubtitleURLs(child, addSubtitleURL, seen);
    }
  }
}

function extractBalancedJSON(text, startIndex) {
  if (startIndex < 0) {
    return "";
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return "";
}

function normalizeTranscriptSegments(segments) {
  const seen = new Set();
  return (segments || [])
    .filter((segment) => segment && segment.text && segment.startSeconds != null)
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .filter((segment) => {
      const key = `${Math.round(segment.startSeconds)}:${segment.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PLATFORM_TRANSCRIPT_SEGMENTS);
}

function makeTranscriptSegmentFromMilliseconds(startMs, endMs, text, source) {
  const startSeconds = Number(startMs) / 1000;
  const endSeconds = endMs == null ? null : Number(endMs) / 1000;
  return makeTranscriptSegment(startSeconds, endSeconds, text, source);
}

function makeTranscriptSegment(startSeconds, endSeconds, text, source) {
  const cleanText = decodeTranscriptText(normalizeLiteText(text).slice(0, MAX_PLATFORM_TRANSCRIPT_TEXT_LENGTH));
  if (!cleanText) {
    return null;
  }
  const normalizedStart = Math.max(0, Math.round(Number(startSeconds) || 0));
  const normalizedEnd = endSeconds == null ? null : Math.max(normalizedStart, Math.round(Number(endSeconds) || 0));
  return {
    startSeconds: normalizedStart,
    ...(normalizedEnd == null ? {} : { endSeconds: normalizedEnd }),
    timestamp: formatTimestamp(normalizedStart),
    text: cleanText,
    source,
  };
}

function decodeTranscriptText(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(text || "");
  return normalizeLiteText(textarea.value);
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(remainingSeconds)}`
    : `${two(minutes)}:${two(remainingSeconds)}`;
}

function buildLightweightPageContext() {
  const visual = extractVisualStateLite();
  const hostname = window.location.hostname || "";
  const pathname = window.location.pathname || "";
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const title = document.title || "Untitled";
  const mainText =
    normalizeLiteText(document.querySelector("main")?.innerText) ||
    normalizeLiteText(document.querySelector("article")?.innerText) ||
    "";

  return {
    site: detectSiteLite(hostname),
    url: window.location.href,
    title,
    selection,
    articleText: mainText || `title: ${title}\nurl: ${window.location.href}`,
    videoRAGSummary: "",
    structureSummary: "",
    interactiveSummary: "",
    interactiveTargets: [],
    focusedInput: null,
    videoTranscript: [],
    videoFrameSamples: [],
    metadata: {
      domain: hostname,
      pageKind: inferPageKindLite(hostname, pathname),
      contentStrategy: "lightweight_visual_probe",
      pageBackgroundColor: visual.backgroundColor,
      pageBackgroundImage: visual.backgroundImage,
      pageColorScheme: visual.colorScheme,
      pageBackgroundSource: visual.source,
      headingCount: "0",
      interactiveCount: "0",
      tableCount: "0",
      codeBlockCount: "0",
      hasIframes: document.querySelector("iframe") ? "true" : "false",
      hasShadowHosts: "false",
    },
  };
}

function extractVisualStateLite() {
  const candidates = [
    document.querySelector("[data-testid='primaryColumn']"),
    document.querySelector("main"),
    document.querySelector("article"),
    document.body,
    document.documentElement,
  ].filter(Boolean);

  let fallbackImage = "none";
  let fallbackScheme = "";

  for (const candidate of candidates) {
    let current = candidate;
    while (current) {
      const computedStyle = getComputedStyle(current);
      const backgroundImage = String(computedStyle.backgroundImage || "").trim() || "none";
      const backgroundColor = String(computedStyle.backgroundColor || "").trim();
      const colorScheme = normalizeColorSchemeLite(computedStyle.colorScheme);

      if (!fallbackScheme && colorScheme) {
        fallbackScheme = colorScheme;
      }
      if (fallbackImage === "none" && backgroundImage !== "none") {
        fallbackImage = backgroundImage;
      }
      if (backgroundColor && !isTransparentLite(backgroundColor)) {
        return {
          backgroundColor,
          backgroundImage: backgroundImage !== "none" ? backgroundImage : fallbackImage,
          colorScheme: colorScheme || fallbackScheme || inferSchemeFromColorLite(backgroundColor),
          source: describeNodeLite(current),
        };
      }
      current = current.parentElement;
    }
  }

  const fallbackColor = fallbackScheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
  return {
    backgroundColor: fallbackColor,
    backgroundImage: fallbackImage,
    colorScheme: fallbackScheme || inferSchemeFromColorLite(fallbackColor),
    source: "lightweight_fallback",
  };
}

function detectSiteLite(hostname) {
  if (hostname.includes("github.com")) return "github";
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be") {
    return "youtube";
  }
  if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) {
    return "bilibili";
  }
  return "unsupported";
}

function inferPageKindLite(hostname, pathname) {
  const site = detectSiteLite(hostname);
  if (site === "x") {
    if (/\/status\/\d+/.test(pathname)) return "x_post";
    if (pathname === "/home") return "x_home";
  }
  if (site === "github") return "github_page";
  if (site === "gmail") return "gmail_page";
  if (site === "yahoo_mail") return "yahoo_mail_page";
  if (site === "youtube") {
    if (pathname === "/watch" || pathname.startsWith("/shorts/") || pathname.startsWith("/live/")) {
      return "youtube_video";
    }
    return "youtube_page";
  }
  if (site === "bilibili") {
    if (/\/video\//.test(pathname) || /\/BV[a-zA-Z0-9]+/.test(pathname)) {
      return "bilibili_video";
    }
    return "bilibili_page";
  }
  return "page";
}

function normalizeLiteText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 12000);
}

function describeNodeLite(node) {
  if (!node) return "unknown";
  const tag = String(node.tagName || "").toLowerCase() || "unknown";
  const id = node.id ? `#${node.id}` : "";
  return `${tag}${id}`;
}

function normalizeColorSchemeLite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("dark") && !normalized.includes("light")) return "dark";
  if (normalized.includes("light") && !normalized.includes("dark")) return "light";
  return "";
}

function isTransparentLite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)";
}

function inferSchemeFromColorLite(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)/);
  if (!match) {
    return "dark";
  }
  const red = Number.parseFloat(match[1]);
  const green = Number.parseFloat(match[2]);
  const blue = Number.parseFloat(match[3]);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance >= 0.6 ? "light" : "dark";
}

function rememberCurrentSelection() {
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  if (!selection) {
    return;
  }

  lastStableSelection = selection;
  lastStableSelectionURL = window.location.href;
}

function truncateDebugValue(value) {
  const text = String(value || "").trim();
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 157)}...`;
}

function resolveInteractiveTarget(targetId, selectorHint) {
  if (targetId) {
    const direct = interactiveTargetIndex.get(targetId);
    if (direct && document.contains(direct)) {
      return direct;
    }

    const knownTarget = latestInteractiveTargets.find((item) => item.id === targetId);
    if (knownTarget?.selectorHint) {
      const resolved = queryInteractiveSelector(knownTarget.selectorHint);
      if (resolved) {
        interactiveTargetIndex.set(targetId, resolved);
        return resolved;
      }
    }
  }

  if (selectorHint) {
    return queryInteractiveSelector(selectorHint);
  }

  return null;
}

function queryInteractiveSelector(selectorHint) {
  if (!selectorHint) {
    return null;
  }

  try {
    return document.querySelector(selectorHint);
  } catch {
    return null;
  }
}

function observeVisualChanges() {
  const root = document.documentElement;
  if (!root || typeof MutationObserver !== "function") {
    return;
  }

  const observer = new MutationObserver(() => {
    queueContextSync();
  });

  observer.observe(root, {
    attributes: true,
    childList: true,
    subtree: true,
  });
}

function observeSystemAppearance() {
  if (typeof window.matchMedia !== "function") {
    return;
  }

  try {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", () => queueContextSync());
      return;
    }
    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(() => queueContextSync());
    }
  } catch {
    // Ignore unsupported matchMedia environments.
  }
}
