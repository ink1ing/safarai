import { describeWriteTarget, isWritableElement, resolveWritableTarget } from "./write-target.js";

export function extractPageContext(win, doc) {
  const site = detectSite(win.location.hostname);
  const adapter = getSiteAdapter(site);
  const domain = normalizeHostname(win.location.hostname);

  const selection = normalizeWhitespace(win.getSelection?.()?.toString?.() ?? "");
  const metadata = adapter.extractMetadata(win.location.pathname, doc);
  const focusedInput = extractFocusedInput(doc.activeElement, {
    site,
    domain,
    ...metadata,
  });
  const articleText = adapter.extractArticleText(doc);

  return {
    site,
    url: win.location.href,
    title: doc.title || "Untitled",
    selection,
    articleText,
    focusedInput,
    metadata: {
      domain,
      ...metadata,
    },
  };
}

export function detectSite(hostname) {
  if (hostname.includes("github.com")) return "github";
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
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
    default:
      return genericAdapter;
  }
}

const genericAdapter = {
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
  extractArticleText(doc) {
    const candidates = [
      doc.querySelector(".markdown-body"),
      doc.querySelector("[data-testid='issue-body']"),
      doc.querySelector("[data-testid='issue-viewer-issue-container']"),
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
    };
  },
};

const gmailAdapter = {
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

function pickFirstMeaningfulText(nodes) {
  for (const node of nodes) {
    const text = normalizeWhitespace(readNodeText(node));
    if (text.length >= 120) {
      return text.slice(0, 12000);
    }
  }

  return "";
}

function readNodeText(node) {
  if (!node) {
    return "";
  }

  return node.innerText || node.textContent || "";
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

function buildStructuredPageText(doc) {
  const sections = [
    pickSectionText(doc, "h1, h2, h3", 8),
    pickSectionText(doc, "p, li, blockquote", 24),
    pickSectionText(doc, "pre, code", 8),
  ].filter(Boolean);

  return normalizeWhitespace(sections.join("\n\n")).slice(0, 12000);
}

function pickSectionText(doc, selector, limit) {
  const nodes = Array.from(doc.querySelectorAll?.(selector) || []).slice(0, limit);
  const parts = nodes
    .map((node) => normalizeWhitespace(readNodeText(node)))
    .filter((text) => text.length >= (selector.includes("h1") ? 2 : 12));
  return parts.join("\n");
}

function normalizeHostname(hostname) {
  return String(hostname || "").replace(/^www\./, "").trim();
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
