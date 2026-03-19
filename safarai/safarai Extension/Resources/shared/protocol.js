export const SUPPORTED_SITES = ["github", "gmail", "x", "yahoo_mail"];

export function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function createRequest(type, payload = {}) {
  return {
    id: generateRequestId(),
    type,
    payload,
  };
}

export function createSuccessResponse(payload = {}) {
  return {
    ok: true,
    payload,
  };
}

export function createErrorResponse(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

export function isSupportedSite(site) {
  return SUPPORTED_SITES.includes(site);
}
