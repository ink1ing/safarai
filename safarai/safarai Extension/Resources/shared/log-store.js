const LOG_KEY = "safari_ai_logs";
const MAX_LOGS = 50;

export async function appendLog(entry) {
  const current = await loadLogs();
  const next = pruneLogs([
    {
      timestamp: new Date().toISOString(),
      ...entry,
    },
    ...current,
  ]);

  await browser.storage.local.set({
    [LOG_KEY]: next,
  });

  return next;
}

export async function loadLogs() {
  const result = await browser.storage.local.get(LOG_KEY);
  return Array.isArray(result?.[LOG_KEY]) ? result[LOG_KEY] : [];
}

export function pruneLogs(entries) {
  return entries.slice(0, MAX_LOGS);
}
