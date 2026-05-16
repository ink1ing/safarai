const MAX_VIDEO_TRANSCRIPT_LENGTH = 16_000;
const MAX_VIDEO_PAGE_TEXT_LENGTH = 4_000;
const MAX_VIDEO_DESCRIPTION_LENGTH = 3_000;

export function detectVideoContext(win, doc, options = {}) {
  const hostname = String(options.hostname ?? win?.location?.hostname ?? "");
  const pathname = String(options.pathname ?? win?.location?.pathname ?? "");
  const href = String(options.href ?? win?.location?.href ?? "");
  const site = String(options.site ?? detectVideoSite(hostname));
  const detectedAt = new Date().toISOString();
  const pageKind = String(options.pageKind ?? inferVideoPageKind(site, pathname, doc));

  if (!isSupportedVideoPageKind(pageKind)) {
    return null;
  }

  if (pageKind === "x_video_post" && !hasXVideo(doc)) {
    return null;
  }

  switch (pageKind) {
    case "youtube_video":
      return {
        platform: "youtube",
        pageKind,
        mediaId: extractYouTubeMediaID(href, pathname),
        canonicalUrl: buildYouTubeCanonicalURL(href, pathname),
        title:
          firstMeaningfulText(doc, ["meta[property='og:title']", "meta[name='title']"]) ||
          normalizeWhitespace(String(doc?.title ?? "").replace(/\s*-\s*YouTube\s*$/i, "")),
        author: firstMeaningfulText(doc, ["#owner #channel-name a", "ytd-channel-name a", "meta[itemprop='author']"]),
        duration: readMetaContent(doc, "meta[itemprop='duration']"),
        description: firstMeaningfulText(doc, ["#description-inline-expander", "#description", "meta[name='description']"]),
        postText: "",
        transcriptText: "",
        transcriptLanguage: "",
        transcriptAvailability: "partial",
        transcriptReason: "not_requested",
        transcriptSource: "none",
        summaryInputSource: "",
        summaryText: "",
        fallbackDetail: "",
        summaryReady: false,
        summaryMode: "metadata_only",
        detectedAt,
      };
    case "bilibili_video":
      return {
        platform: "bilibili",
        pageKind,
        mediaId: extractBilibiliMediaID(pathname),
        canonicalUrl: buildCanonicalURL(href),
        title:
          firstMeaningfulText(doc, ["h1.video-title", "meta[property='og:title']"]) ||
          normalizeWhitespace(String(doc?.title ?? "").replace(/\s*_[^_]*哔哩哔哩.*$/i, "")),
        author: firstMeaningfulText(doc, [".up-name", ".username", "meta[name='author']"]),
        duration: "",
        description: firstMeaningfulText(doc, [".video-desc-container", ".desc-info-text", "meta[name='description']"]),
        postText: "",
        transcriptText: "",
        transcriptLanguage: "",
        transcriptAvailability: "partial",
        transcriptReason: "not_requested",
        transcriptSource: "none",
        summaryInputSource: "",
        summaryText: "",
        fallbackDetail: "",
        summaryReady: false,
        summaryMode: "metadata_only",
        detectedAt,
      };
    case "x_video_post":
      return {
        platform: "x",
        pageKind,
        mediaId: extractXMediaID(pathname, doc),
        canonicalUrl: buildCanonicalURL(href),
        title:
          firstMeaningfulText(doc, ["meta[property='og:title']", "meta[name='twitter:title']"]) ||
          normalizeWhitespace(String(doc?.title ?? "").replace(/\s*\/\s*X\s*$/i, "")),
        author: extractXAuthor(doc),
        duration: extractXDuration(doc),
        description:
          firstMeaningfulText(doc, ["meta[property='og:description']", "meta[name='twitter:description']"]) ||
          "",
        postText: extractXPostText(doc),
        transcriptText: "",
        transcriptLanguage: "",
        transcriptAvailability: "partial",
        transcriptReason: "not_requested",
        transcriptSource: "none",
        summaryInputSource: "",
        summaryText: "",
        fallbackDetail: "",
        summaryReady: false,
        summaryMode: "metadata_only",
        detectedAt,
      };
    default:
      return null;
  }
}

export async function resolveVideoContext(win, doc, currentVideoContext = null) {
  const detected = currentVideoContext ?? detectVideoContext(win, doc);
  if (!detected) {
    return null;
  }

  switch (detected.platform) {
    case "youtube":
      return resolveYouTubeVideoContext(win, doc, detected);
    case "bilibili":
      return resolveBilibiliVideoContext(win, doc, detected);
    case "x":
      return resolveXVideoContext(win, doc, detected);
    default:
      return detected;
  }
}

export function applyResolvedVideoContext(pageContext, videoContext) {
  if (!pageContext || !videoContext) {
    return pageContext;
  }

  const metadata = {
    ...(pageContext.metadata ?? {}),
    ...buildLegacyVideoMetadata(videoContext),
  };

  const nextContext = {
    ...pageContext,
    articleText: buildVideoArticleText(videoContext, pageContext.articleText ?? "", pageContext.url ?? ""),
    metadata,
    videoContext,
  };

  const existingSummary = String(pageContext.structureSummary ?? "").trim();
  const nextVideoSummary = buildVideoStructureSummary(videoContext);
  nextContext.structureSummary = replaceOrAppendVideoSummary(existingSummary, nextVideoSummary);
  return nextContext;
}

export function buildLegacyVideoMetadata(videoContext) {
  const transcriptAvailable = videoContext.transcriptAvailability === "available";
  const summaryReady = videoContext.summaryReady === true;
  const transcriptStatus = transcriptAvailable
    ? "ok"
    : videoContext.transcriptReason === "not_requested"
      ? "pending"
      : videoContext.transcriptReason;

  return {
    pageKind: videoContext.pageKind,
    videoPlatform: videoContext.platform,
    videoTitle: videoContext.title || "",
    videoAuthor: videoContext.author || "",
    videoDuration: videoContext.duration || "",
    transcriptAvailable: transcriptAvailable ? "true" : "false",
    transcriptLanguage: videoContext.transcriptLanguage || "",
    transcriptSource: videoContext.transcriptSource === "none" ? "" : videoContext.transcriptSource,
    summaryReady: summaryReady ? "true" : "false",
    summaryInputSource: videoContext.summaryInputSource || "",
    fallbackDetail: videoContext.fallbackDetail || "",
    transcriptStatus,
    transcriptDetail:
      videoContext.transcriptAvailability === "available"
        ? ""
        : videoContext.fallbackDetail || videoContext.transcriptReason || "",
    contentStrategy: buildVideoContentStrategy(videoContext),
  };
}

export function buildVideoArticleText(videoContext, fallbackPageText = "", contextURL = "") {
  if (!videoContext) {
    return trimToLength(normalizeWhitespace(fallbackPageText), MAX_VIDEO_PAGE_TEXT_LENGTH);
  }

  const sections = [];
  if (videoContext.title) sections.push(`video_title: ${videoContext.title}`);
  if (videoContext.author) sections.push(`video_author: ${videoContext.author}`);
  if (videoContext.duration) sections.push(`video_duration: ${videoContext.duration}`);
  sections.push(`video_url: ${videoContext.canonicalUrl || contextURL || ""}`);
  if (videoContext.description) {
    sections.push(`video_description:\n${trimToLength(videoContext.description, MAX_VIDEO_DESCRIPTION_LENGTH)}`);
  }
  if (videoContext.postText) {
    sections.push(`video_post_text:\n${trimToLength(videoContext.postText, MAX_VIDEO_DESCRIPTION_LENGTH)}`);
  }
  if (videoContext.transcriptText) {
    sections.push(`video_transcript:\n${trimToLength(videoContext.transcriptText, MAX_VIDEO_TRANSCRIPT_LENGTH)}`);
  } else if (videoContext.summaryText) {
    sections.push(`${summarySectionLabel(videoContext.summaryInputSource)}:\n${trimToLength(videoContext.summaryText, MAX_VIDEO_TRANSCRIPT_LENGTH)}`);
  } else {
    const normalizedFallback = trimToLength(normalizeWhitespace(fallbackPageText), MAX_VIDEO_PAGE_TEXT_LENGTH);
    if (normalizedFallback && !normalizedFallback.startsWith("video_title:")) {
      sections.push(`video_page_text:\n${normalizedFallback}`);
    }
  }
  return sections.join("\n\n").slice(0, MAX_VIDEO_TRANSCRIPT_LENGTH + MAX_VIDEO_PAGE_TEXT_LENGTH + 1024);
}

function buildVideoStructureSummary(videoContext) {
  const parts = [
    `platform=${videoContext.platform}`,
    `page=${videoContext.pageKind}`,
    videoContext.title ? `title=${videoContext.title}` : null,
    videoContext.author ? `author=${videoContext.author}` : null,
    videoContext.duration ? `duration=${videoContext.duration}` : null,
    `transcript=${videoContext.transcriptAvailability}`,
    `summary_ready=${videoContext.summaryReady === true}`,
    videoContext.summaryInputSource ? `summary_source=${videoContext.summaryInputSource}` : null,
    videoContext.transcriptLanguage ? `language=${videoContext.transcriptLanguage}` : null,
    videoContext.transcriptSource !== "none" ? `source=${videoContext.transcriptSource}` : null,
  ].filter(Boolean);
  return parts.length ? `video_context: ${parts.join(" ; ")}` : "";
}

function summarySectionLabel(summaryInputSource) {
  switch (summaryInputSource) {
    case "official_summary":
      return "video_official_summary";
    case "chapter_points":
      return "video_chapter_points";
    case "page_text":
      return "video_page_text";
    case "metadata_only":
      return "video_summary";
    default:
      return "video_summary";
  }
}

function replaceOrAppendVideoSummary(existingSummary, videoSummary) {
  if (!videoSummary) {
    return existingSummary;
  }
  if (!existingSummary) {
    return videoSummary;
  }
  const lines = existingSummary
    .split("\n")
    .filter((line) => !line.startsWith("video_context:"));
  lines.push(videoSummary);
  return lines.join("\n");
}

async function resolveYouTubeVideoContext(win, doc, detected) {
  const domTranscriptResult = await ensureYouTubeTranscriptFromDOM(win, doc);
  const html = await fetchText(win, String(win?.location?.href ?? ""));
  const playerResponse = extractYouTubePlayerResponse(doc, html);
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const preferredTrack = choosePreferredTrack(captionTracks, detected);
  const transcriptURL = preferredTrack?.baseUrl ? decodeHtmlEntities(String(preferredTrack.baseUrl)) : "";

  let transcriptResult = domTranscriptResult;
  if (!transcriptResult.text) {
    if (transcriptURL) {
      transcriptResult = await fetchYouTubeTranscript(win, transcriptURL);
    } else {
      transcriptResult = {
        text: "",
        availability: "unavailable",
        reason: captionTracks.length ? "fetch_failed" : "no_tracks",
        source: "none",
        language: "",
      };
    }
  }

  const resolved = finalizeResolvedVideoContext(detected, {
    title:
      detected.title ||
      readPlayerTitle(playerResponse) ||
      normalizeWhitespace(String(doc?.title ?? "").replace(/\s*-\s*YouTube\s*$/i, "")),
    author: detected.author || readPlayerAuthor(playerResponse),
    duration: detected.duration || readPlayerDuration(playerResponse),
    description: detected.description || readPlayerDescription(playerResponse),
    transcriptText: transcriptResult.text,
    transcriptLanguage: transcriptResult.language || String(preferredTrack?.languageCode ?? ""),
    transcriptAvailability: transcriptResult.text ? "available" : transcriptResult.availability ?? "unavailable",
    transcriptReason: transcriptResult.text ? "not_requested" : transcriptResult.reason ?? "fetch_failed",
    transcriptSource: transcriptResult.text ? transcriptResult.source ?? "caption_api" : "none",
    summaryInputSource: transcriptResult.text ? "transcript" : "",
    summaryText: transcriptResult.text || "",
    fallbackDetail: "",
    summaryReady: transcriptResult.text ? true : false,
    summaryMode: transcriptResult.text ? "transcript_plus_metadata" : "metadata_only",
  });

  return transcriptResult.text
    ? resolved
    : resolveSummaryFallback(resolved, {
        officialSummaryText: "",
        chapterPointsText: extractYouTubeChapterPoints(doc),
        pageText: buildYouTubeFallbackText(doc),
        fallbackDetailPrefix: "youtube_no_subtitles",
      });
}

async function resolveBilibiliVideoContext(win, doc, detected) {
  const html = await fetchText(win, String(win?.location?.href ?? ""));
  const playInfo =
    parseEmbeddedJson(html, "__playinfo__") ||
    parseEmbeddedJson(html, "window.__playinfo__");
  const initialState =
    parseEmbeddedJson(html, "__INITIAL_STATE__") ||
    parseEmbeddedJson(html, "window.__INITIAL_STATE__");
  const viewInfo = await fetchBilibiliViewInfo(win, detected.mediaId);
  const bvid = String(viewInfo?.bvid ?? detected.mediaId ?? "");
  const cid = String(viewInfo?.cid ?? extractBilibiliCID(initialState) ?? "");
  const playerInfo = await fetchBilibiliPlayerInfo(win, bvid, cid);
  const subtitleList =
    playerInfo?.subtitle?.subtitles ??
    playInfo?.data?.subtitle?.subtitles ??
    playInfo?.subtitle?.subtitles ??
    [];
  const preferredSubtitle = choosePreferredTrack(subtitleList, detected, {
    languageAccessor: (item) => item?.lan_doc || item?.lan || "",
    isManualAccessor: (item) => !/auto|自动/i.test(String(item?.lan_doc ?? item?.lan ?? "")),
  });
  const subtitleURL = preferredSubtitle?.subtitle_url ? normalizeBilibiliSubtitleURL(preferredSubtitle.subtitle_url) : "";
  const transcriptText = subtitleURL ? await fetchBilibiliTranscript(win, subtitleURL) : "";
  const transcriptAvailability = transcriptText ? "available" : "unavailable";
  const resolved = finalizeResolvedVideoContext(detected, {
    title: detected.title || normalizeWhitespace(String(viewInfo?.title ?? "")),
    author: detected.author || normalizeWhitespace(String(viewInfo?.owner?.name ?? "")),
    duration: detected.duration || formatVideoDurationSeconds(viewInfo?.duration),
    description: detected.description || normalizeWhitespace(String(viewInfo?.desc ?? "")),
    transcriptText,
    transcriptLanguage: String(preferredSubtitle?.lan_doc ?? preferredSubtitle?.lan ?? ""),
    transcriptAvailability,
    transcriptReason: transcriptText ? "not_requested" : (subtitleURL ? "fetch_failed" : "no_tracks"),
    transcriptSource: transcriptText ? "subtitle_api" : "none",
    summaryInputSource: transcriptText ? "transcript" : "",
    summaryText: transcriptText || "",
    fallbackDetail: "",
    summaryReady: transcriptText ? true : false,
    summaryMode: transcriptText ? "transcript_plus_metadata" : "metadata_only",
  });

  if (transcriptText) {
    return resolved;
  }

  const officialSummary = await fetchBilibiliOfficialSummary(win, bvid, cid);
  const chapterPoints = buildBilibiliChapterPoints(playerInfo?.view_points);
  return resolveSummaryFallback(resolved, {
    officialSummaryText: officialSummary.text,
    chapterPointsText: chapterPoints,
    pageText: buildBilibiliFallbackText(doc, viewInfo),
    fallbackDetailPrefix: "bilibili_no_subtitles",
    officialSummaryReason: officialSummary.reason,
  });
}

async function resolveXVideoContext(win, doc, detected) {
  const trackSource = extractDOMTrackSource(doc);
  if (trackSource) {
    const transcriptText = await fetchTrackTranscript(win, trackSource);
    if (transcriptText) {
      return finalizeResolvedVideoContext(detected, {
        transcriptText,
        transcriptAvailability: "available",
        transcriptReason: "not_requested",
        transcriptSource: "track",
        summaryInputSource: "transcript",
        summaryText: transcriptText,
        fallbackDetail: "",
        summaryReady: true,
        summaryMode: "transcript_plus_metadata",
      });
    }
  }

  return resolveSummaryFallback(finalizeResolvedVideoContext(detected, {
    transcriptText: "",
    transcriptAvailability: "unavailable",
    transcriptReason: "not_exposed",
    transcriptSource: "none",
    summaryInputSource: "",
    summaryText: "",
    fallbackDetail: "",
    summaryReady: false,
    summaryMode: "metadata_only",
  }), {
    officialSummaryText: "",
    chapterPointsText: "",
    pageText: buildXFallbackText(doc, detected),
    fallbackDetailPrefix: "x_no_captions",
  });
}

function finalizeResolvedVideoContext(base, patch) {
  return {
    ...base,
    ...patch,
    title: normalizeWhitespace(patch.title ?? base.title ?? ""),
    author: normalizeWhitespace(patch.author ?? base.author ?? ""),
    duration: normalizeWhitespace(patch.duration ?? base.duration ?? ""),
    description: normalizeWhitespace(patch.description ?? base.description ?? ""),
    postText: normalizeWhitespace(patch.postText ?? base.postText ?? ""),
    transcriptText: trimToLength(normalizeWhitespace(patch.transcriptText ?? base.transcriptText ?? ""), MAX_VIDEO_TRANSCRIPT_LENGTH),
    transcriptLanguage: normalizeWhitespace(patch.transcriptLanguage ?? base.transcriptLanguage ?? ""),
    summaryInputSource: normalizeWhitespace(patch.summaryInputSource ?? base.summaryInputSource ?? ""),
    summaryText: trimToLength(normalizeWhitespace(patch.summaryText ?? base.summaryText ?? ""), MAX_VIDEO_TRANSCRIPT_LENGTH),
    fallbackDetail: normalizeWhitespace(patch.fallbackDetail ?? base.fallbackDetail ?? ""),
    summaryReady: patch.summaryReady ?? base.summaryReady ?? false,
    detectedAt: base.detectedAt || new Date().toISOString(),
  };
}

function buildVideoContentStrategy(videoContext) {
  if (videoContext.transcriptAvailability === "available") {
    return `${videoContext.platform}_transcript`;
  }
  if (videoContext.summaryReady === true) {
    return `${videoContext.platform}_${videoContext.summaryInputSource || "metadata_only"}`;
  }
  return `${videoContext.platform}_pending`;
}

function resolveSummaryFallback(videoContext, options = {}) {
  const officialSummaryText = trimToLength(normalizeWhitespace(options.officialSummaryText || ""), MAX_VIDEO_TRANSCRIPT_LENGTH);
  if (officialSummaryText) {
    return finalizeResolvedVideoContext(videoContext, {
      summaryInputSource: "official_summary",
      summaryText: officialSummaryText,
      fallbackDetail: `${options.fallbackDetailPrefix || "video"}_official_summary`,
      summaryReady: true,
      summaryMode: "fallback_summary",
    });
  }

  const chapterPointsText = trimToLength(normalizeWhitespace(options.chapterPointsText || ""), MAX_VIDEO_TRANSCRIPT_LENGTH);
  if (chapterPointsText) {
    return finalizeResolvedVideoContext(videoContext, {
      summaryInputSource: "chapter_points",
      summaryText: chapterPointsText,
      fallbackDetail: `${options.fallbackDetailPrefix || "video"}_chapter_points`,
      summaryReady: true,
      summaryMode: "fallback_summary",
    });
  }

  const pageText = trimToLength(normalizeWhitespace(options.pageText || ""), MAX_VIDEO_PAGE_TEXT_LENGTH);
  if (pageText) {
    return finalizeResolvedVideoContext(videoContext, {
      summaryInputSource: "page_text",
      summaryText: pageText,
      fallbackDetail: `${options.fallbackDetailPrefix || "video"}_page_text`,
      summaryReady: true,
      summaryMode: "fallback_summary",
    });
  }

  return finalizeResolvedVideoContext(videoContext, {
    summaryInputSource: "metadata_only",
    summaryText: buildMetadataOnlySummary(videoContext),
    fallbackDetail: options.officialSummaryReason || `${options.fallbackDetailPrefix || "video"}_metadata_only`,
    summaryReady: true,
    summaryMode: "metadata_only",
  });
}

function buildMetadataOnlySummary(videoContext) {
  return [
    videoContext.title ? `title: ${videoContext.title}` : "",
    videoContext.author ? `author: ${videoContext.author}` : "",
    videoContext.duration ? `duration: ${videoContext.duration}` : "",
    videoContext.description ? `description: ${videoContext.description}` : "",
    videoContext.postText ? `post_text: ${videoContext.postText}` : "",
  ].filter(Boolean).join("\n");
}

function extractYouTubeChapterPoints(doc) {
  const selectors = [
    "ytd-macro-markers-list-item-renderer",
    "ytd-engagement-panel-section-list-renderer [data-testid='chapter']",
    "a[href*='t=']",
  ];
  const candidates = selectors.flatMap((selector) =>
    Array.from(doc?.querySelectorAll?.(selector) || [])
  );

  const lines = uniqueStrings(candidates.map((node) => normalizeWhitespace(readNodeText(node))));
  return lines.slice(0, 24).join("\n");
}

function buildYouTubeFallbackText(doc) {
  return uniqueStrings([
    firstMeaningfulText(doc, ["#description-inline-expander", "#description", "meta[name='description']"]),
    firstMeaningfulText(doc, ["#secondary", "main", "article"]),
  ]).join("\n");
}

async function fetchBilibiliViewInfo(win, bvid) {
  if (!bvid) {
    return null;
  }
  const payload = await fetchJSON(win, `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  return payload?.data ?? null;
}

async function fetchBilibiliPlayerInfo(win, bvid, cid) {
  if (!bvid || !cid) {
    return null;
  }
  const payload = await fetchJSON(win, `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`);
  return payload?.data ?? null;
}

async function fetchBilibiliOfficialSummary(win, bvid, cid) {
  if (!bvid || !cid) {
    return { text: "", reason: "bilibili_summary_missing_identifiers" };
  }

  const payload = await fetchJSON(win, `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`);
  if (!payload) {
    return { text: "", reason: "bilibili_summary_fetch_failed" };
  }

  if (Number(payload.code ?? 0) !== 0) {
    return {
      text: "",
      reason: Number(payload.code) === -403 ? "bilibili_summary_forbidden" : `bilibili_summary_code_${payload.code}`,
    };
  }

  const modelResult = payload?.data?.model_result ?? payload?.data ?? {};
  const summary = normalizeWhitespace(String(modelResult?.summary ?? ""));
  const outlineLines = [];
  const outlineGroups = Array.isArray(modelResult?.outline) ? modelResult.outline : [];
  for (const group of outlineGroups) {
    const title = normalizeWhitespace(String(group?.title ?? ""));
    const partLines = Array.isArray(group?.part_outline)
      ? group.part_outline
          .map((item) => {
            const timestamp = formatTimestampSeconds(item?.timestamp ?? item?.start ?? item?.from);
            const content = normalizeWhitespace(String(item?.content ?? item?.title ?? ""));
            return [timestamp ? `[${timestamp}]` : "", content].filter(Boolean).join(" ");
          })
          .filter(Boolean)
      : [];
    if (title) {
      outlineLines.push(title);
    }
    outlineLines.push(...partLines);
  }

  const text = uniqueStrings([summary, outlineLines.join("\n")]).join("\n");
  return {
    text: trimToLength(text, MAX_VIDEO_TRANSCRIPT_LENGTH),
    reason: text ? "" : "bilibili_summary_empty",
  };
}

function buildBilibiliChapterPoints(viewPoints) {
  const lines = (Array.isArray(viewPoints) ? viewPoints : [])
    .map((item) => {
      const timestamp = formatTimestampSeconds(item?.from ?? item?.start);
      const content = normalizeWhitespace(String(item?.content ?? item?.title ?? ""));
      return [timestamp ? `[${timestamp}]` : "", content].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  return trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH);
}

function buildBilibiliFallbackText(doc, viewInfo) {
  return uniqueStrings([
    normalizeWhitespace(String(viewInfo?.desc ?? "")),
    firstMeaningfulText(doc, [".video-desc-container", ".desc-info-text", "#viewbox_report", "main"]),
  ]).join("\n");
}

function extractBilibiliCID(initialState) {
  const pages = Array.isArray(initialState?.videoData?.pages) ? initialState.videoData.pages : [];
  return pages[0]?.cid ?? initialState?.videoData?.cid ?? initialState?.cid ?? "";
}

function buildXFallbackText(doc, detected) {
  return uniqueStrings([
    detected.postText,
    detected.description,
    firstMeaningfulText(doc, ["article", "main"]),
  ]).join("\n");
}

function formatVideoDurationSeconds(value) {
  const seconds = Number(value ?? 0);
  return seconds > 0 ? formatTimestampSeconds(seconds) : "";
}

function isSupportedVideoPageKind(pageKind) {
  return pageKind === "youtube_video" || pageKind === "bilibili_video" || pageKind === "x_video_post";
}

function detectVideoSite(hostname) {
  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "youtu.be") {
    return "youtube";
  }
  if (hostname === "www.bilibili.com" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv") {
    return "bilibili";
  }
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  return "unsupported";
}

function inferVideoPageKind(site, pathname, doc) {
  if (site === "youtube") {
    if (pathname === "/watch" || pathname.startsWith("/shorts/") || pathname.startsWith("/live/")) {
      return "youtube_video";
    }
    return "youtube_page";
  }
  if (site === "bilibili") {
    if (pathname.startsWith("/video/") || pathname.startsWith("/bangumi/play/")) {
      return "bilibili_video";
    }
    return "bilibili_page";
  }
  if (site === "x") {
    if (/\/status\/\d+/.test(pathname) && hasXVideo(doc)) {
      return "x_video_post";
    }
    if (/\/status\/\d+/.test(pathname)) {
      return "x_post";
    }
    return "x_page";
  }
  return "page";
}

function extractYouTubeMediaID(href, pathname) {
  try {
    const url = new URL(href);
    const direct = url.searchParams.get("v");
    if (direct) {
      return direct;
    }
  } catch {}

  const segments = String(pathname || "").split("/").filter(Boolean);
  if (segments[0] === "shorts" || segments[0] === "live") {
    return segments[1] ?? "";
  }
  return "";
}

function buildYouTubeCanonicalURL(href, pathname) {
  const mediaId = extractYouTubeMediaID(href, pathname);
  if (!mediaId) {
    return buildCanonicalURL(href);
  }
  return `https://www.youtube.com/watch?v=${mediaId}`;
}

function extractBilibiliMediaID(pathname) {
  const segments = String(pathname || "").split("/").filter(Boolean);
  if (segments[0] === "video") {
    return segments[1] ?? "";
  }
  if (segments[0] === "bangumi" && segments[1] === "play") {
    return segments[2] ?? "";
  }
  return "";
}

function extractXMediaID(pathname, doc) {
  const tweetId = extractXTweetID(pathname);
  const mediaKey =
    readAttribute(doc?.querySelector?.("[data-testid='videoPlayer']"), "data-media-key") ||
    readAttribute(doc?.querySelector?.("video"), "data-media-key");
  return mediaKey ? `${tweetId}:${mediaKey}` : tweetId;
}

function extractXTweetID(pathname) {
  const match = String(pathname || "").match(/\/status\/(\d+)/);
  return match?.[1] ?? "";
}

function buildCanonicalURL(href) {
  try {
    return new URL(href).toString();
  } catch {
    return String(href || "");
  }
}

function hasXVideo(doc) {
  return Boolean(
    doc?.querySelector?.("[data-testid='videoComponent']") ||
      doc?.querySelector?.("[data-testid='videoPlayer']") ||
      doc?.querySelector?.("video") ||
      doc?.querySelector?.("article [aria-label*='video']")
  );
}

function extractXPostText(doc) {
  const primaryArticle = doc?.querySelector?.("article");
  const candidates = [];

  if (primaryArticle?.querySelectorAll) {
    const textNodes = primaryArticle.querySelectorAll("[data-testid='tweetText']") || [];
    for (const node of textNodes) {
      const value = normalizeWhitespace(readNodeText(node));
      if (value) {
        candidates.push(value);
      }
    }
  }

  const fallback = firstMeaningfulText(doc, ["article", "meta[property='og:description']", "meta[name='twitter:description']"]);
  return uniqueStrings([...candidates, fallback]).join("\n");
}

function extractXAuthor(doc) {
  return firstMeaningfulText(doc, [
    "article [data-testid='User-Name']",
    "meta[name='twitter:title']",
    "meta[property='og:title']",
  ]);
}

function extractXDuration(doc) {
  return firstMeaningfulText(doc, [
    "video",
    "meta[property='og:video:duration']",
    "meta[name='twitter:player:duration']",
  ]);
}

function extractDOMTrackSource(doc) {
  return readAttribute(doc?.querySelector?.("video track[kind='captions'], video track[kind='subtitles']"), "src");
}

async function fetchTrackTranscript(win, url) {
  const raw = await fetchText(win, url);
  return parseVttTranscript(raw);
}

async function ensureYouTubeTranscriptFromDOM(win, doc) {
  const existing = readVisibleYouTubeTranscriptFromDOM(doc);
  if (existing.text) {
    return existing;
  }

  const clickedTranscript = clickYouTubeTranscriptButton(doc);
  if (!clickedTranscript) {
    clickYouTubeExpandButton(doc);
    await waitForPage(win, 260);
    clickYouTubeTranscriptButton(doc);
  }

  for (const delay of [180, 360, 720, 1200]) {
    await waitForPage(win, delay);
    const next = readVisibleYouTubeTranscriptFromDOM(doc);
    if (next.text) {
      return {
        ...next,
        source: "dom",
      };
    }
  }

  return {
    text: "",
    availability: "unavailable",
    reason: "fetch_failed",
    source: "none",
    language: "",
  };
}

function readVisibleYouTubeTranscriptFromDOM(doc) {
  const segmentNodes = Array.from(
    doc?.querySelectorAll?.(
      [
        "ytd-transcript-segment-renderer",
        "ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer",
        "ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer",
      ].join(", ")
    ) || []
  );

  const lines = segmentNodes
    .map((node) => {
      const timestamp = normalizeWhitespace(
        readNodeText(node?.querySelector?.(".segment-timestamp")) ||
          readNodeText(node?.querySelector?.("[class*='timestamp']"))
      );
      let text = normalizeWhitespace(
        readNodeText(node?.querySelector?.(".segment-text")) ||
          readNodeText(node?.querySelector?.("[class*='segment-text']")) ||
          readNodeText(node)
      );
      if (!text) {
        return "";
      }
      if (timestamp && text.startsWith(timestamp)) {
        text = normalizeWhitespace(text.slice(timestamp.length));
      }
      return timestamp ? `[${timestamp}] ${text}` : text;
    })
    .filter(Boolean);

  return {
    text: trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH),
    availability: lines.length ? "available" : "unavailable",
    reason: lines.length ? "not_requested" : "fetch_failed",
    source: lines.length ? "dom" : "none",
    language: "",
  };
}

function clickYouTubeTranscriptButton(doc) {
  const matcher = /(show transcript|open transcript|transcript|显示文字记录|显示转录|转录稿|文字记录)/i;
  for (const candidate of queryYouTubeActionCandidates(doc)) {
    const text = normalizeWhitespace(readNodeText(candidate));
    const label = normalizeWhitespace(readAttribute(candidate, "aria-label") || readAttribute(candidate, "title"));
    if (matcher.test(text) || matcher.test(label)) {
      candidate.click?.();
      return true;
    }
  }
  return false;
}

function clickYouTubeExpandButton(doc) {
  const matcher = /(^more$|show more|expand|更多|展开|显示更多)/i;
  for (const candidate of queryYouTubeActionCandidates(doc)) {
    const text = normalizeWhitespace(readNodeText(candidate));
    const label = normalizeWhitespace(readAttribute(candidate, "aria-label") || readAttribute(candidate, "title"));
    if (matcher.test(text) || matcher.test(label)) {
      candidate.click?.();
      return true;
    }
  }
  return false;
}

function queryYouTubeActionCandidates(doc) {
  const roots = [
    doc?.querySelector?.("ytd-watch-metadata"),
    doc?.querySelector?.("#description"),
    doc?.querySelector?.("#description-inline-expander"),
    doc?.querySelector?.("ytd-text-inline-expander"),
    doc?.body,
  ].filter(Boolean);

  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    const nodes = root?.querySelectorAll?.("*") || [];
    for (const node of nodes) {
      const clickable = resolveYouTubeClickable(node);
      if (!clickable || seen.has(clickable)) {
        continue;
      }
      seen.add(clickable);
      candidates.push(clickable);
    }
  }
  return candidates;
}

function resolveYouTubeClickable(node) {
  return node?.closest?.(
    [
      "button",
      "[role='button']",
      "tp-yt-paper-button",
      "yt-button-shape",
      "yt-button-shape button",
      "ytd-button-renderer",
      "ytd-menu-service-item-renderer",
      "tp-yt-paper-item",
      "yt-formatted-string",
    ].join(", ")
  ) || null;
}

async function fetchYouTubeTranscript(win, url) {
  const transcriptURL = url.includes("fmt=json3") ? url : `${url}${url.includes("?") ? "&" : "?"}fmt=json3`;
  const raw = await fetchText(win, transcriptURL);
  if (!raw) {
    return {
      text: "",
      availability: "unavailable",
      reason: "fetch_failed",
      source: "none",
      language: "",
    };
  }

  const jsonResult = parseYouTubeJsonTranscript(raw);
  if (jsonResult.text) {
    return {
      ...jsonResult,
      availability: "available",
      reason: "not_requested",
      source: "caption_api",
    };
  }

  const xmlText = parseYouTubeXmlTranscript(raw);
  return {
    text: xmlText,
    availability: xmlText ? "available" : "unavailable",
    reason: xmlText ? "not_requested" : "parse_failed",
    source: xmlText ? "caption_api" : "none",
    language: "",
  };
}

async function fetchBilibiliTranscript(win, url) {
  const response = await fetchJSON(win, url);
  const body = Array.isArray(response?.body) ? response.body : [];
  const lines = body
    .map((item) => {
      const timestamp = formatTimestampSeconds(item?.from);
      const text = normalizeWhitespace(String(item?.content ?? ""));
      return timestamp && text ? `[${timestamp}] ${text}` : text;
    })
    .filter(Boolean);
  return trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH);
}

function parseYouTubeJsonTranscript(raw) {
  try {
    const payload = JSON.parse(raw);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const lines = events
      .map((event) => {
        const start = formatTimestampMilliseconds(event?.tStartMs);
        const text = (event?.segs ?? [])
          .map((segment) => String(segment?.utf8 ?? ""))
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        return start && text ? `[${start}] ${text}` : text;
      })
      .filter(Boolean);
    return {
      text: trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH),
    };
  } catch {
    return { text: "" };
  }
}

function parseYouTubeXmlTranscript(raw) {
  const matches = Array.from(String(raw || "").matchAll(/<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g));
  const lines = matches
    .map(([, start, text]) => {
      const decoded = decodeHtmlEntities(String(text || "").replace(/<[^>]+>/g, " "));
      const normalized = normalizeWhitespace(decoded);
      const timestamp = formatTimestampSeconds(Number(start));
      return timestamp && normalized ? `[${timestamp}] ${normalized}` : normalized;
    })
    .filter(Boolean);
  return trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH);
}

function parseVttTranscript(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^WEBVTT$/i.test(line) && !/^\d+$/.test(line) && !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line));
  return trimToLength(lines.join("\n"), MAX_VIDEO_TRANSCRIPT_LENGTH);
}

function extractYouTubePlayerResponse(doc, html) {
  return (
    readYouTubePlayerResponseFromDocument(doc) ||
    parseEmbeddedJson(html, "ytInitialPlayerResponse") ||
    parseEmbeddedJson(html, "var ytInitialPlayerResponse") ||
    null
  );
}

function readYouTubePlayerResponseFromDocument(doc) {
  if (doc?.defaultView?.ytInitialPlayerResponse) {
    return doc.defaultView.ytInitialPlayerResponse;
  }

  const scripts = Array.from(doc?.querySelectorAll?.("script") || []);
  for (const script of scripts) {
    const text = readNodeText(script);
    const parsed =
      parseEmbeddedJson(text, "ytInitialPlayerResponse") ||
      parseEmbeddedJson(text, "var ytInitialPlayerResponse");
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function parseEmbeddedJson(source, marker) {
  if (!source || !marker) {
    return null;
  }

  const index = source.indexOf(marker);
  if (index < 0) {
    return null;
  }

  const start = source.indexOf("{", index);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function choosePreferredTrack(tracks, detected, options = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) {
    return null;
  }

  const languageAccessor = options.languageAccessor ?? ((item) => item?.languageCode || "");
  const isManualAccessor = options.isManualAccessor ?? ((item) => String(item?.kind ?? "") === "");
  const preferredLanguages = detectPreferredLanguages(detected);

  const manual = list.filter((item) => isManualAccessor(item));
  const ranked = manual.length ? manual : list;

  for (const preferredLanguage of preferredLanguages) {
    const match = ranked.find((item) => String(languageAccessor(item)).toLowerCase().startsWith(preferredLanguage));
    if (match) {
      return match;
    }
  }

  return ranked[0];
}

function detectPreferredLanguages(detected) {
  const preferred = [];
  const currentLanguage = String(detected?.transcriptLanguage ?? "").toLowerCase();
  if (currentLanguage) {
    preferred.push(currentLanguage);
  }
  preferred.push("zh", "en");
  return preferred;
}

function readPlayerTitle(playerResponse) {
  return normalizeWhitespace(
    String(playerResponse?.videoDetails?.title ?? "")
  );
}

function readPlayerAuthor(playerResponse) {
  return normalizeWhitespace(
    String(playerResponse?.videoDetails?.author ?? "")
  );
}

function readPlayerDescription(playerResponse) {
  return normalizeWhitespace(
    String(playerResponse?.videoDetails?.shortDescription ?? "")
  );
}

function readPlayerDuration(playerResponse) {
  const seconds = Number(playerResponse?.videoDetails?.lengthSeconds ?? 0);
  return seconds > 0 ? formatISODurationFromSeconds(seconds) : "";
}

async function fetchText(win, url) {
  if (!url || typeof win?.fetch !== "function") {
    return "";
  }
  const response = await win.fetch(url, { credentials: "include" }).catch(() => null);
  if (!response?.ok || typeof response.text !== "function") {
    return "";
  }
  return await response.text();
}

async function fetchJSON(win, url) {
  if (!url || typeof win?.fetch !== "function") {
    return null;
  }
  const response = await win.fetch(url, { credentials: "include" }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  if (typeof response.text === "function") {
    try {
      return JSON.parse(await response.text());
    } catch {
      return null;
    }
  }
  return null;
}

function waitForPage(win, delayMs) {
  return new Promise((resolve) => {
    const timer = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
    timer(resolve, delayMs);
  });
}

function normalizeBilibiliSubtitleURL(url) {
  if (!url) {
    return "";
  }
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  return url;
}

function firstMeaningfulText(doc, selectors) {
  for (const selector of selectors) {
    const node = doc?.querySelector?.(selector);
    const text =
      normalizeWhitespace(readMetaContent(node) || readNodeText(node));
    if (text.length >= 2) {
      return text;
    }
  }
  return "";
}

function readMetaContent(nodeOrDoc, selector = null) {
  const node = selector ? nodeOrDoc?.querySelector?.(selector) : nodeOrDoc;
  return normalizeWhitespace(readAttribute(node, "content"));
}

function readNodeText(node) {
  return String(node?.innerText ?? node?.textContent ?? "").trim();
}

function readAttribute(node, key) {
  if (!node || typeof node.getAttribute !== "function") {
    return "";
  }
  return String(node.getAttribute(key) ?? "").trim();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimToLength(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = normalizeWhitespace(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function formatTimestampMilliseconds(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  return formatTimestampParts(totalSeconds);
}

function formatTimestampSeconds(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0)));
  return formatTimestampParts(totalSeconds);
}

function formatTimestampParts(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatISODurationFromSeconds(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return `PT${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}${remainingSeconds}S`;
}
