const HIGHLIGHT_ATTR = "data-safari-ai-highlighted";
const GITHUB_COMMENT_SELECTORS = [
  "textarea[placeholder*='Leave a comment']",
  "textarea[aria-label*='Comment']",
  "textarea[name='comment[body]']",
  "[data-testid='comment-box'] textarea",
  "[data-testid='markdown-editor'] textarea",
  "[contenteditable='true'][aria-label*='Comment']",
];

const GMAIL_COMPOSER_SELECTORS = [
  "[role='textbox'][g_editable='true']",
  "div[aria-label*='Message Body']",
  "div[aria-label*='邮件正文']",
  "div[contenteditable='true'][role='textbox']",
];

const X_COMPOSER_SELECTORS = [
  "[data-testid='tweetTextarea_0']",
  "[role='textbox'][data-testid='tweetTextarea_0']",
  "[aria-label*='Post text']",
  "[aria-label*='Reply text']",
];

const YAHOO_MAIL_SELECTORS = [
  "[data-test-id='compose-editor']",
  "div[contenteditable='true'][aria-label*='Message body']",
  "div[contenteditable='true'][aria-label*='邮件正文']",
];

export function describeWriteTarget(activeElement, metadata = {}) {
  if (!activeElement) {
    return null;
  }

  const tagName = String(activeElement.tagName || "").toLowerCase() || "div";
  const label = inferElementLabel(activeElement);
  const placeholder =
    readAttribute(activeElement, "placeholder") ||
    readAttribute(activeElement, "data-placeholder") ||
    readAttribute(activeElement, "aria-placeholder");
  const text = [metadata.repository, metadata.domain, metadata.pageKind, label || placeholder || "输入框"]
    .filter(Boolean)
    .join(" / ");

  return {
    type: tagName,
    label,
    placeholder,
    description: text,
  };
}

export function isWritableElement(activeElement) {
  if (!activeElement) {
    return false;
  }

  const tagName = String(activeElement.tagName || "").toLowerCase();
  if (tagName === "textarea") {
    return !activeElement.disabled && !activeElement.readOnly;
  }

  if (tagName === "input") {
    const type = String(activeElement.type || "text").toLowerCase();
    const supported = ["text", "search", "email", "url", "tel"];
    return supported.includes(type) && !activeElement.disabled && !activeElement.readOnly;
  }

  if (activeElement.isContentEditable === true || activeElement.contentEditable === "true") {
    return true;
  }

  const role = readAttribute(activeElement, "role").toLowerCase();
  return role === "textbox";
}

export function resolveWritableTarget(doc, activeElement, metadata = {}) {
  const normalizedActive = normalizeEditableTarget(activeElement);
  if (isWritableElement(normalizedActive)) {
    return normalizedActive;
  }

  const highlighted = doc?.querySelector?.(`[${HIGHLIGHT_ATTR}="true"]`);
  const normalizedHighlighted = normalizeEditableTarget(highlighted);
  if (isWritableElement(normalizedHighlighted)) {
    return normalizedHighlighted;
  }

  if (metadata.site === "github") {
    for (const selector of GITHUB_COMMENT_SELECTORS) {
      const candidate = doc?.querySelector?.(selector);
      if (isWritableElement(candidate)) {
        return candidate;
      }
    }
  }

  if (metadata.site === "gmail") {
    for (const selector of GMAIL_COMPOSER_SELECTORS) {
      const candidate = doc?.querySelector?.(selector);
      if (isWritableElement(candidate)) {
        return candidate;
      }
    }
  }

  if (metadata.site === "x") {
    for (const selector of X_COMPOSER_SELECTORS) {
      const candidate = doc?.querySelector?.(selector);
      if (isWritableElement(candidate)) {
        return candidate;
      }
    }
  }

  if (metadata.site === "yahoo_mail") {
    for (const selector of YAHOO_MAIL_SELECTORS) {
      const candidate = doc?.querySelector?.(selector);
      if (isWritableElement(candidate)) {
        return candidate;
      }
    }
  }

  const genericFallbacks = [
    "textarea",
    "input[type='text']",
    "input[type='search']",
    "input[type='email']",
    "input[type='tel']",
    "[role='textbox']",
    "[aria-multiline='true']",
    "[contenteditable='true']",
    ".ProseMirror",
    ".ql-editor",
  ];

  for (const selector of genericFallbacks) {
    const candidate = normalizeEditableTarget(doc?.querySelector?.(selector));
    if (isWritableElement(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function highlightElement(element) {
  if (!element) {
    return;
  }

  clearHighlight(element.ownerDocument);
  element.setAttribute(HIGHLIGHT_ATTR, "true");
  element.style.outline = "3px solid #1f6f5f";
  element.style.outlineOffset = "3px";
  element.style.boxShadow = "0 0 0 6px rgba(31, 111, 95, 0.18)";
}

export function clearHighlight(doc) {
  const highlighted = doc?.querySelector?.(`[${HIGHLIGHT_ATTR}="true"]`);
  if (!highlighted) {
    return;
  }

  highlighted.removeAttribute(HIGHLIGHT_ATTR);
  highlighted.style.outline = "";
  highlighted.style.outlineOffset = "";
  highlighted.style.boxShadow = "";
}

export function applyDraftToElement(element, draft) {
  if (!element || typeof draft !== "string") {
    return false;
  }

  const tagName = String(element.tagName || "").toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    element.focus?.();
    element.value = draft;
    dispatchInputEvents(element);
    return true;
  }

  if (element.isContentEditable === true || element.contentEditable === "true") {
    element.focus?.();
    element.textContent = draft;
    dispatchInputEvents(element);
    return true;
  }

  return false;
}

export function copyDraftFallback(win, doc, draft) {
  const text = String(draft ?? "");
  if (!text) {
    return false;
  }

  if (win?.navigator?.clipboard?.writeText) {
    win.navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }

  if (!doc?.createElement || !doc?.body?.appendChild) {
    return false;
  }

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);
  textarea.select?.();

  try {
    return doc.execCommand?.("copy") === true;
  } finally {
    textarea.remove?.();
  }
}

function dispatchInputEvents(element) {
  element.dispatchEvent?.(new Event("input", { bubbles: true }));
  element.dispatchEvent?.(new Event("change", { bubbles: true }));
}

function readAttribute(node, key) {
  if (!node || typeof node.getAttribute !== "function") {
    return "";
  }

  return node.getAttribute(key) || "";
}

function inferElementLabel(node) {
  return (
    readAttribute(node, "aria-label") ||
    readAttribute(node, "name") ||
    readAttribute(node, "id") ||
    readAttribute(node, "placeholder") ||
    readAttribute(node, "data-placeholder")
  );
}

function normalizeEditableTarget(node) {
  let current = node;

  while (current) {
    if (isWritableElement(current)) {
      return current;
    }

    if (typeof current.closest === "function") {
      const closestEditable =
        current.closest("[contenteditable='true']") ||
        current.closest("[role='textbox']") ||
        current.closest(".ProseMirror") ||
        current.closest(".ql-editor");
      if (closestEditable) {
        return closestEditable;
      }
    }

    current = current.parentElement || null;
  }

  return null;
}
