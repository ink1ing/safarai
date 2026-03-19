const MAX_MESSAGES = 20;

export async function loadSession(tabId) {
  const key = sessionKey(tabId);
  const result = await browser.storage.local.get(key);
  const value = result?.[key];
  return Array.isArray(value) ? value : [];
}

export async function saveSession(tabId, messages) {
  const key = sessionKey(tabId);
  const next = pruneMessages(messages);
  await browser.storage.local.set({
    [key]: next,
  });
  return next;
}

export function pruneMessages(messages) {
  return messages.slice(-MAX_MESSAGES);
}

function sessionKey(tabId) {
  return `safari_ai_session_${tabId}`;
}
