import { describeWriteTarget, isWritableElement, resolveWritableTarget } from "./write-target.js";

const MAX_ARTICLE_TEXT_LENGTH = 12_000;
const MAX_INTERACTIVE_SUMMARY_ITEMS = 12;
const MAX_INTERACTIVE_TARGETS = 20;
const MAX_VIDEO_TRANSCRIPT_SEGMENTS = 240;
const MAX_VIDEO_TRANSCRIPT_TEXT_LENGTH = 360;
const MAX_VIDEO_RAG_SIGNAL_LENGTH = 6000;
const TRAVERSAL_SKIP_TAGS = new Set([
  "script",
  "style",
  "template",
  "svg",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "noscript",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3"]);
const TEXT_BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "pre",
  "code",
  "td",
  "th",
  "dt",
  "dd",
]);
const CONTAINER_TEXT_TAGS = new Set(["article", "section", "main", "div"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
  "textbox",
]);

export function extractPageContext(win, doc) {
  const site = detectSite(win.location.hostname);
  const adapter = getSiteAdapter(site);
  const domain = normalizeHostname(win.location.hostname);

  const selection = normalizeWhitespace(win.getSelection?.()?.toString?.() ?? "");
  const videoContext = extractVideoContext(win, doc, site);
  const videoRAGSummary = buildVideoRAGSummary(doc, site);
  const metadata = {
    ...adapter.extractMetadata(win.location.pathname, doc),
    ...videoContext.metadata,
  };
  const rootSelection = selectContentRoot(win, doc, adapter);
  const articleExtraction = buildArticleText(win, doc, rootSelection, adapter);
  const pageVisual = extractPageVisualState(win, doc, rootSelection.root);
  const pageAnalysis = analyzeTree(win, doc.body ?? rootSelection.root, {
    collectInteractive: true,
  });
  const focusedInput = extractFocusedInput(doc.activeElement, {
    site,
    domain,
    ...metadata,
  });

  const structureSummary = buildStructureSummary({
    rootSelection,
    metadata,
    contentStrategy: articleExtraction.contentStrategy,
    pageAnalysis,
  });
  const interactiveSummary = buildInteractiveSummary(pageAnalysis.interactive);
  const interactiveTargets = pageAnalysis.interactive
    .slice(0, MAX_INTERACTIVE_TARGETS)
    .map(serializeInteractiveTarget);

  const context = {
    site,
    url: win.location.href,
    title: doc.title || "Untitled",
    selection,
    articleText: articleExtraction.text,
    videoTranscript: videoContext.transcript,
    videoRAGSummary,
    structureSummary,
    interactiveSummary,
    interactiveTargets,
    focusedInput,
    metadata: {
      domain,
      ...metadata,
      pageBackgroundColor: pageVisual.backgroundColor,
      pageBackgroundImage: pageVisual.backgroundImage,
      pageColorScheme: pageVisual.colorScheme,
      pageBackgroundSource: pageVisual.source,
      contentStrategy: articleExtraction.contentStrategy,
      headingCount: String(rootSelection.analysis.headingCount),
      interactiveCount: String(pageAnalysis.interactiveCount),
      tableCount: String(rootSelection.analysis.tableCount),
      codeBlockCount: String(rootSelection.analysis.codeBlockCount),
      hasIframes: pageAnalysis.hasIframes ? "true" : "false",
      hasShadowHosts: pageAnalysis.hasShadowHosts ? "true" : "false",
    },
  };

  Object.defineProperty(context, "__interactiveTargetIndex", {
    value: pageAnalysis.interactiveIndex,
    enumerable: false,
  });

  return context;
}

export function detectSite(hostname) {
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

function getSiteAdapter(site) {
  switch (site) {
    case "github":
      return githubAdapter;
    case "gmail":
      return gmailAdapter;
    case "x":
      return xAdapter;
    case "yahoo_mail":
      return yahooMailAdapter;
    case "youtube":
      return youtubeAdapter;
    case "bilibili":
      return bilibiliAdapter;
    default:
      return genericAdapter;
  }
}

const genericAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      { selector: "main", strategy: "generic_main", label: "main", priority: 240 },
      { selector: "article", strategy: "generic_article", label: "article", priority: 220 },
      { selector: "[role='main']", strategy: "generic_role_main", label: "[role=main]", priority: 200 },
      { node: doc.body, strategy: "generic_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    const candidates = [
      doc.querySelector("main"),
      doc.querySelector("article"),
      doc.querySelector(".content"),
      doc.querySelector(".post"),
      doc.querySelector(".article"),
      doc.querySelector("[role='main']"),
      doc.body,
    ].filter(Boolean);

    const directText = pickFirstMeaningfulText(candidates);
    if (directText.length >= 120) {
      return directText;
    }

    return buildStructuredPageText(doc);
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferGenericPageKind(pathname),
      hasCodeBlocks: Boolean(doc.querySelector("pre, code")),
      hasForms: Boolean(doc.querySelector("form, textarea, input, [contenteditable='true'], [role='textbox']")),
    };
  },
};

const githubAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      { selector: ".markdown-body", strategy: "github_markdown_body", label: ".markdown-body", priority: 2800 },
      { selector: "[data-testid='issue-body']", strategy: "github_issue_body", label: "issue-body", priority: 2700 },
      {
        selector: "[data-testid='issue-viewer-issue-container']",
        strategy: "github_issue_container",
        label: "issue-container",
        priority: 2600,
      },
      { selector: "[data-testid='readme-content']", strategy: "github_readme", label: "readme-content", priority: 2500 },
      { selector: ".js-comment-body", strategy: "github_comment_body", label: "comment-body", priority: 2400 },
      { selector: "main", strategy: "github_main", label: "main", priority: 600 },
      { node: doc.body, strategy: "github_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    const candidates = [
      doc.querySelector(".markdown-body"),
      doc.querySelector("[data-testid='issue-body']"),
      doc.querySelector("[data-testid='issue-viewer-issue-container']"),
      doc.querySelector("[data-testid='readme-content']"),
      doc.querySelector(".js-comment-body"),
      doc.querySelector("main"),
      doc.body,
    ].filter(Boolean);

    return pickFirstMeaningfulText(candidates);
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferGitHubPageKind(pathname),
      repository: extractGitHubRepository(pathname),
      hasCommentEditor: Boolean(
        doc.querySelector("textarea[placeholder*='comment'], textarea[aria-label*='comment'], [contenteditable='true']")
      ),
      mainTab: firstMeaningfulText(doc, [
        ".UnderlineNav-item.selected",
        ".UnderlineNav-item[aria-current='page']",
        "[role='tab'][aria-selected='true']",
        "a[aria-current='page']",
      ]),
      statePills: collectMeaningfulTexts(doc, [
        "[data-testid='header-state']",
        "[data-testid='issue-state']",
        ".State",
      ], 3).join(", "),
      primaryActions: collectMeaningfulTexts(doc, [
        "[data-testid='review-changes-button']",
        "[data-testid='comment-button']",
        ".gh-header-actions button",
        ".gh-header-actions a",
        "main button",
      ], 4).join(", "),
    };
  },
};

const gmailAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      { selector: ".a3s", strategy: "gmail_message_body", label: ".a3s", priority: 2200 },
      { selector: ".ii.gt", strategy: "gmail_thread_body", label: ".ii.gt", priority: 2100 },
      { selector: "[role='main']", strategy: "gmail_main_role", label: "[role=main]", priority: 600 },
      { selector: "main", strategy: "gmail_main", label: "main", priority: 420 },
      { node: doc.body, strategy: "gmail_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    const candidates = [
      doc.querySelector("[role='main']"),
      doc.querySelector(".a3s"),
      doc.querySelector(".ii.gt"),
      doc.querySelector("main"),
      doc.body,
    ].filter(Boolean);

    return pickFirstMeaningfulText(candidates);
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferGmailPageKind(pathname),
      hasCommentEditor: Boolean(
        doc.querySelector("[role='textbox'][g_editable='true'], div[aria-label*='Message Body']")
      ),
    };
  },
};

const xAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      { selector: "article", strategy: "x_article", label: "article", priority: 2200 },
      { selector: "[data-testid='primaryColumn']", strategy: "x_primary_column", label: "primary-column", priority: 1800 },
      { selector: "main", strategy: "x_main", label: "main", priority: 500 },
      { node: doc.body, strategy: "x_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    const candidates = [
      doc.querySelector("article"),
      doc.querySelector("[data-testid='primaryColumn']"),
      doc.querySelector("main"),
      doc.body,
    ].filter(Boolean);

    return pickFirstMeaningfulText(candidates);
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferXPageKind(pathname),
      hasCommentEditor: Boolean(
        doc.querySelector("[data-testid='tweetTextarea_0'], [role='textbox'][data-testid='tweetTextarea_0']")
      ),
    };
  },
};

const yahooMailAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      {
        selector: "[data-test-id='message-view-body-content']",
        strategy: "yahoo_mail_body",
        label: "message-view-body-content",
        priority: 2200,
      },
      { selector: "[data-test-id='mail-reader']", strategy: "yahoo_mail_reader", label: "mail-reader", priority: 2100 },
      { selector: "main", strategy: "yahoo_main", label: "main", priority: 400 },
      { node: doc.body, strategy: "yahoo_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    const candidates = [
      doc.querySelector("[data-test-id='message-view-body-content']"),
      doc.querySelector("[data-test-id='mail-reader']"),
      doc.querySelector("main"),
      doc.body,
    ].filter(Boolean);

    return pickFirstMeaningfulText(candidates);
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferYahooMailPageKind(pathname),
      hasCommentEditor: Boolean(
        doc.querySelector("[data-test-id='compose-editor'], div[contenteditable='true'][aria-label*='Message body']")
      ),
    };
  },
};

const youtubeAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      {
        selector: "ytd-transcript-renderer",
        strategy: "youtube_transcript",
        label: "youtube-transcript",
        priority: 3200,
      },
      {
        selector: "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
        strategy: "youtube_transcript_panel",
        label: "youtube-transcript-panel",
        priority: 3100,
      },
      { selector: "#description", strategy: "youtube_description", label: "#description", priority: 1800 },
      { selector: "#primary", strategy: "youtube_primary", label: "#primary", priority: 700 },
      { selector: "ytd-watch-flexy", strategy: "youtube_watch", label: "ytd-watch-flexy", priority: 600 },
      { selector: "main", strategy: "youtube_main", label: "main", priority: 420 },
      { node: doc.body, strategy: "youtube_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    return buildVideoPageText(doc, {
      titleSelectors: ["h1.ytd-watch-metadata", "h1.title", "h1"],
      authorSelectors: [
        "#owner #channel-name",
        "#upload-info #channel-name",
        "ytd-channel-name",
        "[itemprop='author']",
      ],
      descriptionSelectors: ["#description-inline-expander", "#description", "ytd-text-inline-expander"],
      chapterSelectors: [
        "ytd-macro-markers-list-item-renderer",
        "ytd-expandable-metadata-renderer ytd-metadata-row-renderer",
        "#description a[href*='t=']",
      ],
      commentSelectors: [
        "ytd-comment-thread-renderer #content-text",
        "ytd-comment-renderer #content-text",
        "#comments #content-text",
      ],
      transcriptSelectors: [
        "ytd-transcript-segment-renderer",
        ".segment-text",
        "yt-formatted-string.segment-text",
        "[class*='segment-text']",
      ],
      fallbackSelectors: ["#primary", "ytd-watch-flexy", "main", "body"],
    });
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferYouTubePageKind(pathname),
      videoTitle: firstMeaningfulText(doc, ["h1.ytd-watch-metadata", "h1.title", "h1"]),
      videoAuthor: firstMeaningfulText(doc, [
        "#owner #channel-name",
        "#upload-info #channel-name",
        "ytd-channel-name",
        "[itemprop='author']",
      ]),
      hasTranscript: collectMeaningfulTexts(doc, [
        "ytd-transcript-segment-renderer",
        ".segment-text",
        "yt-formatted-string.segment-text",
      ], 1).length > 0,
    };
  },
};

const bilibiliAdapter = {
  getContentRoots(doc) {
    return buildCandidateRoots(doc, [
      {
        selector: ".bpx-player-subtitle-panel",
        strategy: "bilibili_subtitle_panel",
        label: "bilibili-subtitle-panel",
        priority: 3200,
      },
      {
        selector: ".bpx-player-subtitle-current-text",
        strategy: "bilibili_current_subtitle",
        label: "bilibili-current-subtitle",
        priority: 3000,
      },
      { selector: ".video-desc", strategy: "bilibili_description", label: ".video-desc", priority: 1800 },
      { selector: ".video-info", strategy: "bilibili_info", label: ".video-info", priority: 1200 },
      { selector: "#viewbox_report", strategy: "bilibili_viewbox", label: "viewbox-report", priority: 1000 },
      { selector: "main", strategy: "bilibili_main", label: "main", priority: 420 },
      { node: doc.body, strategy: "bilibili_body", label: "body", priority: 0 },
    ]);
  },

  extractArticleText(doc) {
    return buildVideoPageText(doc, {
      titleSelectors: [".video-title", "h1.video-title", "h1"],
      authorSelectors: [".up-name", ".username", ".name", "[class*='up-name']"],
      descriptionSelectors: [".video-desc", ".desc-info", "[class*='desc']"],
      chapterSelectors: [
        ".video-sections-content-list .video-section-list-item",
        "[class*='chapter']",
        "[class*='section']",
      ],
      commentSelectors: [
        ".reply-content",
        ".comment-content",
        "[class*='reply-content']",
      ],
      transcriptSelectors: [
        ".bpx-player-subtitle-panel-text",
        ".bpx-player-subtitle-current-text",
        ".subtitle-item",
        "[class*='subtitle']",
      ],
      fallbackSelectors: [".video-info", "#viewbox_report", "main", "body"],
    });
  },

  extractMetadata(pathname, doc) {
    return {
      pageKind: inferBilibiliPageKind(pathname),
      videoTitle: firstMeaningfulText(doc, [".video-title", "h1.video-title", "h1"]),
      videoAuthor: firstMeaningfulText(doc, [".up-name", ".username", ".name", "[class*='up-name']"]),
      hasTranscript: collectMeaningfulTexts(doc, [
        ".bpx-player-subtitle-panel-text",
        ".bpx-player-subtitle-current-text",
        ".subtitle-item",
      ], 1).length > 0,
    };
  },
};

function buildCandidateRoots(doc, specs) {
  return specs
    .map((spec) => {
      const node = spec.node ?? doc.querySelector?.(spec.selector) ?? null;
      if (!node) {
        return null;
      }

      return {
        node,
        strategy: spec.strategy,
        label: spec.label,
        priority: spec.priority ?? 0,
      };
    })
    .filter(Boolean);
}

function selectContentRoot(win, doc, adapter) {
  const candidates = adapter.getContentRoots(doc);
  const analyses = candidates
    .map((candidate, index) => ({
      ...candidate,
      index,
      analysis: analyzeTree(win, candidate.node, { collectInteractive: false }),
    }))
    .filter((candidate) => candidate.analysis.blocks.length || candidate.analysis.textLength > 0);

  if (!analyses.length) {
    const fallbackRoot = doc.body ?? null;
    return {
      root: fallbackRoot,
      strategy: fallbackRoot ? "body_fallback" : "no_root",
      label: fallbackRoot ? "body" : "none",
      analysis: analyzeTree(win, fallbackRoot, { collectInteractive: false }),
    };
  }

  analyses.sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
  const best = analyses[0];
  return {
    root: best.node,
    strategy: best.strategy,
    label: best.label,
    analysis: best.analysis,
  };
}

function scoreAnalysis(analysis) {
  return (
    analysis.textLength +
    analysis.headingCount * 120 +
    analysis.paragraphCount * 40 +
    analysis.listCount * 55 +
    analysis.tableCount * 60 +
    analysis.codeBlockCount * 45
  );
}

function scoreCandidate(candidate) {
  const indexBonus = Math.max(0, 400 - candidate.index * 60);
  return scoreAnalysis(candidate.analysis) + indexBonus + (candidate.priority ?? 0);
}

function analyzeTree(win, root, options = {}) {
  const collectInteractive = options.collectInteractive !== false;
  const blocks = [];
  const headings = [];
  const interactive = [];
  const interactiveIndex = new Map();
  const textCache = new Set();

  let headingCount = 0;
  let paragraphCount = 0;
  let listCount = 0;
  let tableCount = 0;
  let codeBlockCount = 0;
  let interactiveCount = 0;
  let hasIframes = false;
  let hasShadowHosts = false;
  let order = 0;

  walkTree(root, (node, depth) => {
    const tagName = getTagName(node);
    if (!tagName) {
      return false;
    }

    if (TRAVERSAL_SKIP_TAGS.has(tagName)) {
      return true;
    }

    if (!isNodeVisible(win, node)) {
      return true;
    }

    order += 1;

    if (tagName === "iframe") {
      hasIframes = true;
      return true;
    }

    if (node.shadowRoot || node.openOrClosedShadowRoot) {
      hasShadowHosts = true;
    }

    if (HEADING_TAGS.has(tagName)) {
      headingCount += 1;
      const text = normalizeWhitespace(readNodeText(node));
      if (text.length >= 2 && headings.length < 6) {
        headings.push(`${tagName.toUpperCase()}: ${text}`);
      }
    }
    if (tagName === "p") paragraphCount += 1;
    if (tagName === "ul" || tagName === "ol") listCount += 1;
    if (tagName === "table") tableCount += 1;
    if (tagName === "pre" || tagName === "code") codeBlockCount += 1;

    const block = buildContentBlock(node);
    if (block && !textCache.has(block.text)) {
      textCache.add(block.text);
      blocks.push({ ...block, depth, order });
    }

    if (collectInteractive) {
      const item = buildInteractiveItem(node, interactive.length);
      if (item) {
        interactiveCount += 1;
        interactiveIndex.set(item.id, node);
        if (interactive.length < MAX_INTERACTIVE_TARGETS) {
          interactive.push({ ...item, order });
        }
      }
    }

    return false;
  });

  const sortedInteractive = interactive.sort(compareInteractiveItems);
  const textLength = blocks.reduce((sum, block) => sum + block.text.length, 0);

  return {
    blocks,
    headings,
    headingCount,
    paragraphCount,
    listCount,
    tableCount,
    codeBlockCount,
    interactive: sortedInteractive,
    interactiveIndex,
    interactiveCount,
    hasIframes,
    hasShadowHosts,
    textLength,
  };
}

function buildArticleText(win, doc, rootSelection, adapter) {
  const primaryText = trimToLength(joinBlocks(rootSelection.analysis.blocks), MAX_ARTICLE_TEXT_LENGTH);
  if (primaryText.length >= 120) {
    return {
      text: primaryText,
      contentStrategy: rootSelection.strategy,
    };
  }

  const fallback = trimToLength(adapter.extractArticleText(doc), MAX_ARTICLE_TEXT_LENGTH);
  if (fallback.length >= 40) {
    return {
      text: fallback,
      contentStrategy: `${rootSelection.strategy}_fallback`,
    };
  }

  return {
    text: "",
    contentStrategy: rootSelection.strategy || "empty",
  };
}

function buildStructureSummary({ rootSelection, metadata, contentStrategy, pageAnalysis }) {
  const lines = [
    `content_strategy: ${contentStrategy}`,
    `main_region: ${rootSelection.label}`,
    `heading_outline: ${rootSelection.analysis.headings.join(" | ") || "none"}`,
    `block_counts: headings=${rootSelection.analysis.headingCount}, paragraphs=${rootSelection.analysis.paragraphCount}, lists=${rootSelection.analysis.listCount}, tables=${rootSelection.analysis.tableCount}, code_blocks=${rootSelection.analysis.codeBlockCount}`,
    `page_signals: interactives=${pageAnalysis.interactiveCount}, iframes=${pageAnalysis.hasIframes}, shadow_hosts=${pageAnalysis.hasShadowHosts}`,
  ];

  if (
    metadata.repository ||
    metadata.pageKind ||
    metadata.mainTab ||
    metadata.statePills ||
    metadata.primaryActions ||
    metadata.videoTitle ||
    metadata.videoAuthor ||
    metadata.hasTranscript != null
  ) {
    const contextParts = [
      metadata.repository ? `repository=${metadata.repository}` : null,
      metadata.pageKind ? `page=${metadata.pageKind}` : null,
      metadata.mainTab ? `tab=${metadata.mainTab}` : null,
      metadata.statePills ? `state=${metadata.statePills}` : null,
      metadata.primaryActions ? `actions=${metadata.primaryActions}` : null,
      metadata.videoTitle ? `video=${metadata.videoTitle}` : null,
      metadata.videoAuthor ? `author=${metadata.videoAuthor}` : null,
      metadata.hasTranscript != null ? `has_transcript=${metadata.hasTranscript}` : null,
    ].filter(Boolean);

    if (contextParts.length) {
      lines.push(`page_context: ${contextParts.join(" ; ")}`);
    }
  }

  return lines.join("\n");
}

function buildInteractiveSummary(items) {
  if (!items.length) {
    return "";
  }

  return items
    .slice(0, MAX_INTERACTIVE_SUMMARY_ITEMS)
    .map((item, index) =>
      `${index + 1}. label=${item.label} | role=${item.role} | type=${item.type} | enabled=${item.enabled} | position=${item.position}`
    )
    .join("\n");
}

function extractPageVisualState(win, doc, root) {
  const candidates = uniqueNodes([
    root,
    doc.activeElement,
    doc.querySelector?.("#root"),
    doc.querySelector?.("#app"),
    doc.querySelector?.("#__next"),
    doc.querySelector?.("[data-testid='primaryColumn']"),
    doc.querySelector?.("[role='main']"),
    doc.querySelector?.("main"),
    doc.querySelector?.("article"),
    doc.body,
    doc.documentElement,
  ]);

  let firstGradientImage = "none";
  let firstGradientSource = "unknown";
  let firstDetectedScheme = "";

  for (const candidate of candidates) {
    let current = candidate;

    while (current) {
      const computedStyle = resolveComputedStyle(win, current);
      const normalizedScheme = normalizeColorScheme(computedStyle?.colorScheme);
      if (!firstDetectedScheme && normalizedScheme) {
        firstDetectedScheme = normalizedScheme;
      }

      const backgroundImage = normalizeBackgroundImage(computedStyle?.backgroundImage);
      if (backgroundImage !== "none" && firstGradientImage === "none") {
        firstGradientImage = backgroundImage;
        firstGradientSource = describeVisualNode(current);
      }

      const backgroundColor = normalizeBackgroundColor(computedStyle?.backgroundColor);
      if (backgroundColor && !isTransparentColor(backgroundColor)) {
        const currentSource = describeVisualNode(current);
        return {
          backgroundColor,
          backgroundImage: backgroundImage !== "none" ? backgroundImage : firstGradientImage,
          colorScheme: normalizedScheme || inferColorSchemeFromColor(backgroundColor),
          source:
            backgroundImage !== "none"
              ? currentSource
              : firstGradientImage !== "none"
                ? firstGradientSource
                : currentSource,
        };
      }

      current = current.parentElement ?? null;
    }
  }

  const fallbackColor = firstDetectedScheme === "dark" ? "rgb(28, 28, 30)" : "rgb(255, 255, 255)";
  return {
    backgroundColor: fallbackColor,
    backgroundImage: firstGradientImage,
    colorScheme: firstDetectedScheme || inferColorSchemeFromColor(fallbackColor),
    source: firstGradientImage !== "none" ? firstGradientSource : "fallback",
  };
}

function buildContentBlock(node) {
  const tagName = getTagName(node);
  const text = normalizeWhitespace(readNodeText(node));
  if (!text) {
    return null;
  }

  if (HEADING_TAGS.has(tagName) && text.length >= 2) {
    return { tagName, text };
  }

  if (TEXT_BLOCK_TAGS.has(tagName)) {
    const minimumLength = tagName === "code" || tagName === "pre" ? 16 : 24;
    return text.length >= minimumLength ? { tagName, text } : null;
  }

  if (CONTAINER_TEXT_TAGS.has(tagName) && isContainerBlock(node, text)) {
    return text.length >= 160 ? { tagName, text } : null;
  }

  return null;
}

function isContainerBlock(node, text) {
  const children = getElementChildren(node);
  if (!children.length) {
    return true;
  }

  const hasRichChildren = children.some((child) => {
    const childTagName = getTagName(child);
    const childText = normalizeWhitespace(readNodeText(child));
    return (
      (TEXT_BLOCK_TAGS.has(childTagName) || CONTAINER_TEXT_TAGS.has(childTagName)) &&
      childText.length >= 40
    );
  });

  if (hasRichChildren) {
    return false;
  }

  return text.length >= 160;
}

function buildInteractiveItem(node, index) {
  if (!isInteractiveElement(node)) {
    return null;
  }

  const label = inferInteractiveLabel(node);
  if (!label) {
    return null;
  }

  const rect = getNodeRect(node);
  const enabled = isInteractiveEnabled(node);
  const role = inferInteractiveRole(node);
  const type = inferInteractiveType(node);

  return {
    id: `target_${index + 1}`,
    label,
    role,
    type,
    enabled: enabled ? "true" : "false",
    selectorHint: buildSelectorHint(node),
    rect: rect
      ? {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : null,
    position: rect
      ? `top=${Math.round(rect.top)} left=${Math.round(rect.left)} size=${Math.round(rect.width)}x${Math.round(rect.height)}`
      : `order=${index + 1}`,
    top: rect?.top ?? Number.MAX_SAFE_INTEGER,
    left: rect?.left ?? Number.MAX_SAFE_INTEGER,
    order: index,
  };
}

function serializeInteractiveTarget(item) {
  return {
    id: item.id,
    label: item.label,
    role: item.role,
    type: item.type,
    enabled: item.enabled,
    selectorHint: item.selectorHint,
    rect: item.rect,
  };
}

function compareInteractiveItems(left, right) {
  if (left.top !== right.top) {
    return left.top - right.top;
  }
  if (left.left !== right.left) {
    return left.left - right.left;
  }
  return left.order - right.order;
}

function isInteractiveElement(node) {
  if (!node) {
    return false;
  }

  if (isWritableElement(node)) {
    return true;
  }

  const tagName = getTagName(node);
  if (tagName === "button" || tagName === "select" || tagName === "summary") {
    return true;
  }

  if (tagName === "a") {
    return Boolean(readAttribute(node, "href") || node.href);
  }

  if (tagName === "input") {
    return String(node.type || "text").toLowerCase() !== "hidden";
  }

  const role = readAttribute(node, "role").toLowerCase();
  return INTERACTIVE_ROLES.has(role);
}

function isInteractiveEnabled(node) {
  if (!node) {
    return false;
  }

  if (node.disabled === true || node.readOnly === true) {
    return false;
  }

  return readAttribute(node, "aria-disabled").toLowerCase() !== "true";
}

function inferInteractiveLabel(node) {
  return normalizeWhitespace(
    readAttribute(node, "aria-label") ||
      readAttribute(node, "title") ||
      readAttribute(node, "placeholder") ||
      readAttribute(node, "value") ||
      readNodeText(node) ||
      readAttribute(node, "name") ||
      readAttribute(node, "id")
  ).slice(0, 120);
}

function inferInteractiveRole(node) {
  const explicitRole = readAttribute(node, "role").toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }

  const tagName = getTagName(node);
  if (tagName === "a") return "link";
  if (tagName === "button") return "button";
  if (tagName === "textarea" || isWritableElement(node)) return "textbox";
  return tagName || "unknown";
}

function inferInteractiveType(node) {
  const tagName = getTagName(node);
  if (tagName === "input") {
    return String(node.type || "text").toLowerCase();
  }

  return tagName || "unknown";
}

function buildSelectorHint(node) {
  if (!node) {
    return "";
  }

  const directSelectors = [
    buildSelectorFromAttribute(node, "id", "#"),
    buildSelectorFromAttribute(node, "data-testid"),
    buildSelectorFromAttribute(node, "name"),
    buildSelectorFromAttribute(node, "aria-label"),
  ].filter(Boolean);

  if (directSelectors.length) {
    return directSelectors[0];
  }

  const segments = [];
  let current = node;
  let depth = 0;

  while (current && depth < 4) {
    const tagName = getTagName(current);
    if (!tagName) {
      break;
    }

    const direct =
      buildSelectorFromAttribute(current, "id", "#") ||
      buildSelectorFromAttribute(current, "data-testid") ||
      buildSelectorFromAttribute(current, "name");
    if (direct) {
      segments.unshift(direct);
      break;
    }

    segments.unshift(buildNthSelector(current));
    current = current.parentElement || null;
    depth += 1;
  }

  return segments.join(" > ");
}

function buildSelectorFromAttribute(node, attribute, prefix = "") {
  const value = readAttribute(node, attribute);
  if (!value) {
    return "";
  }

  if (prefix === "#") {
    return `#${escapeCssValue(value)}`;
  }

  const tagName = getTagName(node) || "*";
  return `${tagName}[${attribute}="${escapeCssValue(value)}"]`;
}

function buildNthSelector(node) {
  const tagName = getTagName(node) || "*";
  const parent = node.parentElement;
  if (!parent) {
    return tagName;
  }

  const siblings = getElementChildren(parent).filter((child) => getTagName(child) === tagName);
  const position = Math.max(1, siblings.indexOf(node) + 1);
  return `${tagName}:nth-of-type(${position})`;
}

function extractFocusedInput(activeElement, metadata = {}) {
  const target = resolveWritableTarget(
    activeElement?.ownerDocument ?? null,
    activeElement,
    { site: metadata.site || "unsupported" }
  ) || activeElement;

  if (!target || !isWritableElement(target)) {
    return null;
  }

  const tagName = String(target.tagName || "").toLowerCase();
  const isContentEditable =
    target.isContentEditable === true || target.contentEditable === "true";
  const description = describeWriteTarget(target, {
    domain: metadata.domain,
    pageKind: metadata.pageKind,
    repository: metadata.repository,
  });

  return {
    type: tagName || "div",
    placeholder:
      target.getAttribute?.("data-placeholder") ||
      target.getAttribute?.("placeholder") ||
      target.getAttribute?.("aria-placeholder") ||
      "",
    label:
      target.getAttribute?.("aria-label") ||
      target.getAttribute?.("name") ||
      "",
    isContentEditable,
    description: description?.description || "",
  };
}

function inferGitHubPageKind(pathname) {
  if (/\/pull\/\d+/.test(pathname)) return "github_pull_request";
  if (/\/issues\/\d+/.test(pathname)) return "github_issue";
  if (/\/blob\//.test(pathname)) return "github_file";

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    return "github_repo";
  }

  return "github_other";
}

function extractGitHubRepository(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  return `${segments[0]}/${segments[1]}`;
}

function inferGenericPageKind(pathname) {
  if (!pathname || pathname === "/") {
    return "homepage";
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length > 1) return "document";
  return "page";
}

function inferGmailPageKind(pathname) {
  if (pathname.includes("/u/")) {
    return "gmail_thread";
  }

  return "gmail_mailbox";
}

function inferXPageKind(pathname) {
  if (/\/status\/\d+/.test(pathname)) {
    return "x_post";
  }

  if (pathname.split("/").filter(Boolean).length >= 1) {
    return "x_timeline";
  }

  return "x_home";
}

function inferYahooMailPageKind(pathname) {
  if (pathname.includes("/d/folders/")) {
    return "yahoo_mail_thread";
  }

  return "yahoo_mailbox";
}

function inferYouTubePageKind(pathname) {
  if (pathname === "/watch" || pathname.startsWith("/shorts/") || pathname.startsWith("/live/")) {
    return "youtube_video";
  }

  return "youtube_page";
}

function inferBilibiliPageKind(pathname) {
  if (/\/video\//.test(pathname) || /\/BV[a-zA-Z0-9]+/.test(pathname)) {
    return "bilibili_video";
  }

  return "bilibili_page";
}

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

function findPrimaryVideo(win, doc) {
  const videos = Array.from(doc.querySelectorAll?.("video") || []);
  if (!videos.length) {
    return null;
  }

  return videos
    .map((video, index) => {
      const rect = getNodeRect(video) ?? { width: 0, height: 0 };
      const area = Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0);
      const visible = isNodeVisible(win, video) && area > 0;
      return { video, index, area: visible ? area : 0 };
    })
    .sort((left, right) => {
      if (left.area !== right.area) return right.area - left.area;
      return left.index - right.index;
    })[0]?.video ?? null;
}

function extractDOMVideoTranscript(doc, site) {
  if (site === "youtube") {
    return extractTimestampedNodes(doc, [
      "ytd-transcript-segment-renderer",
      "ytd-transcript-segment-list-renderer [role='button']",
      "[class*='transcript'] [class*='segment']",
    ], "youtube_transcript_dom");
  }

  if (site === "bilibili") {
    return extractTimestampedNodes(doc, [
      ".bpx-player-subtitle-panel-text",
      ".subtitle-item",
      "[class*='subtitle']",
    ], "bilibili_subtitle_dom");
  }

  return extractTimestampedNodes(doc, [
    "[data-start-time]",
    "[data-start]",
    "[class*='transcript']",
    "[class*='subtitle']",
  ], "generic_video_dom");
}

function extractTimestampedNodes(doc, selectors, source) {
  const nodes = [];
  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll?.(selector) || [])) {
      if (!nodes.includes(node)) {
        nodes.push(node);
      }
    }
  }

  return nodes
    .map((node) => parseTranscriptNode(node, source))
    .filter(Boolean);
}

function parseTranscriptNode(node, source) {
  const rawText = normalizeWhitespace(readNodeText(node));
  if (!rawText) {
    return null;
  }

  const attrStart =
    parseOptionalNumber(readAttribute(node, "data-start-time")) ??
    parseOptionalNumber(readAttribute(node, "data-start")) ??
    parseOptionalNumber(readAttribute(node, "data-time"));
  const timestampMatch = rawText.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/);
  const startSeconds = attrStart ?? parseTimestampSeconds(timestampMatch?.[1] ?? "");
  let text = rawText;
  if (timestampMatch) {
    text = normalizeWhitespace(rawText.replace(timestampMatch[1], ""));
  }
  if (!text || startSeconds == null) {
    return null;
  }

  return makeTranscriptSegment(startSeconds, null, text, source);
}

function extractTextTrackTranscript(video) {
  const tracks = Array.from(video?.textTracks || []);
  for (const track of tracks) {
    const cues = Array.from(track?.cues || track?.activeCues || []);
    const segments = cues
      .map((cue) =>
        makeTranscriptSegment(
          normalizeVideoNumber(cue.startTime) ?? 0,
          normalizeVideoNumber(cue.endTime),
          cue.text ?? "",
          "text_track"
        )
      )
      .filter((segment) => segment.text);
    if (segments.length) {
      return segments;
    }
  }
  return [];
}

function extractVisibleSubtitleTranscript(doc, site, video) {
  const currentTime = normalizeVideoNumber(video?.currentTime) ?? 0;
  const selectors =
    site === "youtube"
      ? [".ytp-caption-segment", ".caption-window"]
      : site === "bilibili"
        ? [".bpx-player-subtitle-current-text", ".bpx-player-subtitle-panel-text"]
        : ["[class*='caption']", "[class*='subtitle']"];

  return collectMeaningfulTexts(doc, selectors, 8)
    .map((text) => makeTranscriptSegment(currentTime, null, text, "visible_subtitle"))
    .filter((segment) => segment.text);
}

function normalizeVideoTranscript(segments) {
  const seen = new Set();
  return segments
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
    .slice(0, MAX_VIDEO_TRANSCRIPT_SEGMENTS);
}

function makeTranscriptSegment(startSeconds, endSeconds, text, source) {
  const normalizedStart = Math.max(0, Math.round(Number(startSeconds) || 0));
  const normalizedEnd = endSeconds == null ? null : Math.max(normalizedStart, Math.round(Number(endSeconds) || 0));
  return {
    startSeconds: normalizedStart,
    ...(normalizedEnd == null ? {} : { endSeconds: normalizedEnd }),
    timestamp: formatTimestamp(normalizedStart),
    text: normalizeWhitespace(String(text || "")).slice(0, MAX_VIDEO_TRANSCRIPT_TEXT_LENGTH),
    source,
  };
}

function parseTimestampSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
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

function normalizeVideoNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseOptionalNumber(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function buildVideoPageText(doc, spec) {
  const sections = [];
  const title = firstMeaningfulText(doc, spec.titleSelectors ?? []);
  const author = firstMeaningfulText(doc, spec.authorSelectors ?? []);
  const description = firstMeaningfulText(doc, spec.descriptionSelectors ?? []);
  const chapters = collectTimestampSignals(doc, spec.chapterSelectors ?? []);
  const comments = collectCommentSignals(doc, spec.commentSelectors ?? []);
  const transcript = collectMeaningfulTexts(doc, spec.transcriptSelectors ?? [], 80).join("\n");

  if (title) sections.push(`video_title: ${title}`);
  if (author) sections.push(`video_author: ${author}`);
  if (description) sections.push(`video_description:\n${description}`);
  if (chapters.length) sections.push(`video_chapters_or_moments:\n${chapters.join("\n")}`);
  if (comments.length) sections.push(`comment_attention_signals:\n${comments.join("\n")}`);
  if (transcript) sections.push(`video_transcript_or_visible_subtitles:\n${transcript}`);

  const combined = sections.join("\n\n").trim();
  if (combined.length >= 40) {
    return combined.slice(0, MAX_ARTICLE_TEXT_LENGTH);
  }

  const fallbackNodes = (spec.fallbackSelectors ?? [])
    .map((selector) => doc.querySelector?.(selector))
    .filter(Boolean);
  return pickFirstMeaningfulText(fallbackNodes);
}

function buildVideoRAGSummary(doc, site) {
  const spec =
    site === "youtube"
      ? {
          descriptionSelectors: ["#description-inline-expander", "#description", "ytd-text-inline-expander"],
          chapterSelectors: [
            "ytd-macro-markers-list-item-renderer",
            "ytd-expandable-metadata-renderer ytd-metadata-row-renderer",
            "#description a[href*='t=']",
            "#description yt-formatted-string",
          ],
          commentSelectors: [
            "ytd-comment-thread-renderer #content-text",
            "ytd-comment-renderer #content-text",
            "#comments #content-text",
          ],
        }
      : site === "bilibili"
        ? {
            descriptionSelectors: [".video-desc", ".desc-info", "[class*='desc']"],
            chapterSelectors: [".video-sections-content-list .video-section-list-item", "[class*='chapter']", "[class*='section']"],
            commentSelectors: [".reply-content", ".comment-content", "[class*='reply-content']"],
          }
        : {
            descriptionSelectors: ["[class*='description']", "[class*='desc']"],
            chapterSelectors: ["[class*='chapter']", "[class*='marker']", "a[href*='t=']"],
            commentSelectors: ["[class*='comment']"],
          };

  const sections = [];
  const description = collectMeaningfulTexts(doc, spec.descriptionSelectors, 3).join("\n");
  const timestampSignals = collectTimestampSignals(doc, [
    ...spec.descriptionSelectors,
    ...spec.chapterSelectors,
  ]);
  const comments = collectCommentSignals(doc, spec.commentSelectors);

  if (description) {
    sections.push(`metadata_description:\n${description}`);
  }
  if (timestampSignals.length) {
    sections.push(`salient_timestamp_signals:\n${timestampSignals.join("\n")}`);
  }
  if (comments.length) {
    sections.push(`collective_attention_signals:\n${comments.join("\n")}`);
  }

  return sections.join("\n\n").slice(0, MAX_VIDEO_RAG_SIGNAL_LENGTH);
}

function collectTimestampSignals(doc, selectors) {
  const seen = new Set();
  const signals = [];
  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll?.(selector) || [])) {
      const text = normalizeWhitespace(readNodeText(node));
      if (!hasTimestamp(text) || seen.has(text)) {
        continue;
      }
      seen.add(text);
      signals.push(text.slice(0, 220));
      if (signals.length >= 24) {
        return rankTimestampSignals(signals);
      }
    }
  }
  return rankTimestampSignals(signals);
}

function collectCommentSignals(doc, selectors) {
  const seen = new Set();
  const comments = [];
  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll?.(selector) || [])) {
      const text = normalizeWhitespace(readNodeText(node));
      if (text.length < 18 || seen.has(text)) {
        continue;
      }
      seen.add(text);
      comments.push(text.slice(0, 240));
      if (comments.length >= 18) {
        return rankCommentSignals(comments);
      }
    }
  }
  return rankCommentSignals(comments);
}

function rankTimestampSignals(items) {
  return items
    .map((text) => ({ text, score: saliencyScore(text) + 8 }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map((item) => item.text);
}

function rankCommentSignals(items) {
  return items
    .map((text) => ({ text, score: saliencyScore(text) + (hasTimestamp(text) ? 4 : 0) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map((item) => item.text);
}

function saliencyScore(text) {
  const value = String(text || "");
  const timestampBonus = hasTimestamp(value) ? 8 : 0;
  const entityBonus = Math.min(12, (value.match(/[A-Z][a-z]+|[\u4e00-\u9fff]{2,}/g) || []).length * 2);
  const numberBonus = Math.min(6, (value.match(/\d+/g) || []).length);
  const quoteBonus = /["“”'‘’]/.test(value) ? 3 : 0;
  const actionBonus = /(出现|发生|宣布|决定|攻击|逮捕|死亡|抗议|演讲|解释|reveals?|shows?|announces?|dies?|killed|protest|speech|decision)/i.test(value) ? 5 : 0;
  return timestampBonus + entityBonus + numberBonus + quoteBonus + actionBonus + Math.min(5, value.length / 80);
}

function hasTimestamp(text) {
  return /(?:^|\D)(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\D|$)/.test(String(text || ""));
}

function buildStructuredPageText(doc) {
  const sections = [
    pickSectionText(doc, "h1, h2, h3", 8),
    pickSectionText(doc, "p, li, blockquote", 24),
    pickSectionText(doc, "pre, code", 8),
  ].filter(Boolean);

  return normalizeWhitespace(sections.join("\n\n")).slice(0, MAX_ARTICLE_TEXT_LENGTH);
}

function pickSectionText(doc, selector, limit) {
  const nodes = Array.from(doc.querySelectorAll?.(selector) || []).slice(0, limit);
  const parts = nodes
    .map((node) => normalizeWhitespace(readNodeText(node)))
    .filter((text) => text.length >= (selector.includes("h1") ? 2 : 12));
  return parts.join("\n");
}

function firstMeaningfulText(doc, selectors) {
  for (const selector of selectors) {
    const text = normalizeWhitespace(readNodeText(doc.querySelector?.(selector)));
    if (text) {
      return text;
    }
  }
  return "";
}

function collectMeaningfulTexts(doc, selectors, limit) {
  const items = [];
  const seen = new Set();

  for (const selector of selectors) {
    const nodes = Array.from(doc.querySelectorAll?.(selector) || []);
    for (const node of nodes) {
      const text = normalizeWhitespace(readNodeText(node));
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      items.push(text);
      if (items.length >= limit) {
        return items;
      }
    }
  }

  return items;
}

function pickFirstMeaningfulText(nodes) {
  for (const node of nodes) {
    const text = normalizeWhitespace(readNodeText(node));
    if (text.length >= 120) {
      return text.slice(0, MAX_ARTICLE_TEXT_LENGTH);
    }
  }

  return "";
}

function walkTree(root, visitor, depth = 0) {
  if (!root || !isElementLike(root)) {
    return;
  }

  const shouldSkipChildren = visitor(root, depth) === true;
  if (shouldSkipChildren) {
    return;
  }

  const children = getElementChildren(root);
  for (const child of children) {
    walkTree(child, visitor, depth + 1);
  }
}

function getElementChildren(node) {
  const rawChildren = Array.isArray(node?.children)
    ? node.children
    : Array.isArray(node?.childNodes)
      ? node.childNodes
      : node?.children
        ? Array.from(node.children)
        : node?.childNodes
          ? Array.from(node.childNodes)
          : [];

  return rawChildren.filter(isElementLike);
}

function isElementLike(node) {
  if (!node) {
    return false;
  }

  if (typeof node.tagName === "string") {
    return true;
  }

  return node.nodeType === 1;
}

function isNodeVisible(win, node) {
  if (!node) {
    return false;
  }

  const tagName = getTagName(node);
  if (!tagName) {
    return false;
  }

  if (hasBooleanAttribute(node, "hidden")) {
    return false;
  }

  if (readAttribute(node, "aria-hidden").toLowerCase() === "true") {
    return false;
  }

  const computedStyle = resolveComputedStyle(win, node);
  if (computedStyle) {
    if (computedStyle.display === "none") {
      return false;
    }
    if (computedStyle.visibility === "hidden") {
      return false;
    }
    if (computedStyle.opacity === "0") {
      return false;
    }
  }

  const rect = getNodeRect(node);
  if (rect) {
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const viewportWidth = Number.isFinite(win.innerWidth) ? win.innerWidth : null;
    const viewportHeight = Number.isFinite(win.innerHeight) ? win.innerHeight : null;
    if (
      viewportWidth != null &&
      viewportHeight != null &&
      (rect.bottom < -120 ||
        rect.top > viewportHeight + 240 ||
        rect.right < -120 ||
        rect.left > viewportWidth + 240)
    ) {
      return false;
    }
  }

  return true;
}

function resolveComputedStyle(win, node) {
  if (typeof win.getComputedStyle === "function") {
    try {
      return win.getComputedStyle(node);
    } catch {
      return null;
    }
  }

  return node.computedStyle ?? null;
}

function getNodeRect(node) {
  if (typeof node?.getBoundingClientRect === "function") {
    try {
      const rect = node.getBoundingClientRect();
      if (rect && Number.isFinite(rect.top) && Number.isFinite(rect.left)) {
        return rect;
      }
    } catch {
      // ignore
    }
  }

  if (node?.rect && Number.isFinite(node.rect.top) && Number.isFinite(node.rect.left)) {
    return node.rect;
  }

  return null;
}

function joinBlocks(blocks) {
  return blocks
    .map((block) => block.text)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

function trimToLength(value, maxLength) {
  return String(value || "").slice(0, maxLength).trim();
}

function uniqueNodes(nodes) {
  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    if (!node || seen.has(node)) {
      continue;
    }
    seen.add(node);
    result.push(node);
  }

  return result;
}

function normalizeBackgroundImage(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "initial" ? normalized : "none";
}

function normalizeBackgroundColor(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function normalizeColorScheme(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized || normalized === "normal") {
    return "";
  }

  if (normalized.includes("dark") && !normalized.includes("light")) {
    return "dark";
  }

  if (normalized.includes("light") && !normalized.includes("dark")) {
    return "light";
  }

  return "";
}

function isTransparentColor(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized === "transparent") {
    return true;
  }

  const channels = parseColorChannels(normalized);
  if (!channels) {
    return false;
  }

  return channels.alpha <= 0.01;
}

function inferColorSchemeFromColor(value) {
  const channels = parseColorChannels(value);
  if (!channels) {
    return "dark";
  }

  const luminance =
    (0.2126 * channels.red + 0.7152 * channels.green + 0.0722 * channels.blue) /
    255;
  return luminance >= 0.6 ? "light" : "dark";
}

function parseColorChannels(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  const rgbMatch = normalized.match(
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[/,]\s*([0-9.]+))?\s*\)$/
  );
  if (rgbMatch) {
    return {
      red: clampChannel(rgbMatch[1]),
      green: clampChannel(rgbMatch[2]),
      blue: clampChannel(rgbMatch[3]),
      alpha: clampAlpha(rgbMatch[4]),
    };
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{3,8})$/i);
  if (!hexMatch) {
    return null;
  }

  const hex = hexMatch[1];
  if (hex.length === 3 || hex.length === 4) {
    return {
      red: parseInt(`${hex[0]}${hex[0]}`, 16),
      green: parseInt(`${hex[1]}${hex[1]}`, 16),
      blue: parseInt(`${hex[2]}${hex[2]}`, 16),
      alpha: hex.length === 4 ? parseInt(`${hex[3]}${hex[3]}`, 16) / 255 : 1,
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    return {
      red: parseInt(hex.slice(0, 2), 16),
      green: parseInt(hex.slice(2, 4), 16),
      blue: parseInt(hex.slice(4, 6), 16),
      alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  return null;
}

function clampChannel(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(255, parsed));
}

function clampAlpha(value) {
  if (value == null) {
    return 1;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(0, Math.min(1, parsed));
}

function describeVisualNode(node) {
  const tagName = getTagName(node);
  if (!tagName) {
    return "unknown";
  }

  const id = readAttribute(node, "id");
  if (id) {
    return `${tagName}#${id}`;
  }

  return tagName;
}

function readNodeText(node) {
  if (!node) {
    return "";
  }

  return node.innerText || node.textContent || "";
}

function readAttribute(node, key) {
  if (!node || typeof node.getAttribute !== "function") {
    return "";
  }

  const value = node.getAttribute(key);
  if (value == null) {
    return "";
  }

  return String(value);
}

function hasBooleanAttribute(node, key) {
  if (!node || typeof node.getAttribute !== "function") {
    return false;
  }

  return node.getAttribute(key) != null;
}

function escapeCssValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function getTagName(node) {
  return String(node?.tagName || "").toLowerCase();
}

function normalizeHostname(hostname) {
  return String(hostname || "").replace(/^www\./, "").trim();
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
