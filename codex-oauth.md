# Codex OAuth and Proxy in anti-api

This document explains how `anti-api` currently supports Codex authentication and how Codex requests are proxied upstream.

## 1. Overview

In this project, Codex support has two major parts:

1. **Auth acquisition and persistence**
   - Import existing local Codex credentials
   - Perform browser OAuth login when import is unavailable
   - Refresh expired access tokens
   - Save usable Codex accounts into anti-api's own account store

2. **Request proxying**
   - Accept OpenAI-compatible or Anthropic-compatible requests at anti-api
   - Route the request to a Codex account when routing chooses `provider = codex`
   - Translate messages/tools into the format expected by ChatGPT Codex backend
   - Send the request to ChatGPT backend Codex endpoints
   - Convert the result back into anti-api's internal response shape, then expose it back through OpenAI/Anthropic-compatible APIs

Main implementation files:

- `/Users/inkling/Desktop/anti-api/src/services/codex/oauth.ts`
- `/Users/inkling/Desktop/anti-api/src/services/codex/chat.ts`
- `/Users/inkling/Desktop/anti-api/src/routes/auth/route.ts`
- `/Users/inkling/Desktop/anti-api/src/services/routing/router.ts`
- `/Users/inkling/Desktop/anti-api/src/routes/messages/handler.ts`
- `/Users/inkling/Desktop/anti-api/src/routes/openai/route.ts`

## 2. Codex auth sources supported by anti-api

anti-api supports two Codex credential sources.

### 2.1 `~/.codex/auth.json`

This is treated as the main Codex CLI auth file.

Relevant constants in `/Users/inkling/Desktop/anti-api/src/services/codex/oauth.ts`:

- `CODEX_AUTH_FILE = ~/.codex/auth.json`
- imported as auth source `codex-cli`

The project parses fields such as:

- `access_token`
- `refresh_token`
- `id_token`
- `account_id`
- `email`
- expiration metadata if present

If the access token is missing or expired, anti-api tries to refresh it before importing.

### 2.2 `~/.cli-proxy-api/codex-*.json`

This directory is treated as the local proxy-style Codex credential store.

Relevant constant:

- `CODEX_PROXY_AUTH_DIR = ~/.cli-proxy-api`

These files are imported as auth source `cli-proxy`.

anti-api scans all `codex-*.json` files, extracts tokens, refreshes if needed, then imports every valid account into its own auth store.

## 3. How Codex accounts are imported

### 3.1 Automatic import path

When `/auth/login` is called with `provider = codex` and `force != true`, anti-api does not immediately open a browser.

Instead it runs:

- `importCodexAuthSources()`

That function tries both:

- `importCodexAuthFile()`
- `importCodexProxyAuthFiles()`

If any valid account is found, the login API returns success with source `import`.

Relevant route:

- `/Users/inkling/Desktop/anti-api/src/routes/auth/route.ts`

### 3.2 Browser OAuth path

If import fails, or the UI explicitly requests interactive login, anti-api supports browser OAuth.

In `/auth/login`, when:

- `provider = codex`
- `force = true`

it calls:

- `startCodexOAuthLogin()`

This performs a real browser OAuth flow against OpenAI auth endpoints.

## 4. How Codex browser OAuth works

Codex OAuth configuration lives in `/Users/inkling/Desktop/anti-api/src/services/codex/oauth.ts`.

Key values:

- authorize URL: `https://auth.openai.com/oauth/authorize`
- token URL: `https://auth.openai.com/oauth/token`
- scopes: `openid email profile offline_access`
- callback port base: `1455`
- callback path: `/auth/callback`

### 4.1 Authorization URL generation

The project builds an OAuth authorize URL with:

- `client_id`
- `redirect_uri`
- `response_type=code`
- `scope`
- `state`
- `prompt=login`
- `id_token_add_organizations=true`
- `codex_cli_simplified_flow=true`

If no client secret is configured, it also generates PKCE values:

- `code_verifier`
- `code_challenge`
- `code_challenge_method=S256`

### 4.2 Local callback listener

anti-api starts a local callback server on port `1455`, or the next available port within `1455-1465`.

Functions involved:

- `ensureCodexCallbackServer()`
- `startOAuthCallbackServer()`
- `startCodexCallbackServer()`

When the browser redirects back to the callback path, anti-api captures:

- `code`
- `state`
- `error`
- effective `redirectUri`

### 4.3 Code exchange

After receiving the callback, anti-api exchanges the authorization code for tokens using:

- `exchangeCodexCode()`

It sends a form POST to:

- `https://auth.openai.com/oauth/token`

with:

- `grant_type=authorization_code`
- `client_id`
- `code`
- `redirect_uri`
- optional `client_secret`
- optional `code_verifier`

The returned values may include:

- `access_token`
- `refresh_token`
- `id_token`
- `expires_in`

anti-api then derives:

- account email from `id_token` claims when available
- account id from `sub` or fallback values

and persists the account into its own auth store.

## 5. Token refresh strategy

anti-api supports refresh for both Codex auth sources.

### 5.1 Standard Codex OAuth refresh

If auth source is normal Codex OAuth / CLI, refresh goes to:

- `https://auth.openai.com/oauth/token`

using:

- `grant_type=refresh_token`
- `client_id`
- `refresh_token`

Function:

- `refreshCodexAccessToken(refreshToken, authSource)`

### 5.2 Proxy-style refresh

If auth source is `cli-proxy`, refresh is delegated to:

- `https://token.oaifree.com/api/auth/refresh`

Function:

- `refreshCodexProxyAccessToken(refreshToken)`

This is why the project can support both native Codex-style auth and proxy-derived local auth artifacts.

### 5.3 Refresh locking

To avoid concurrent refresh races, anti-api uses a `refreshLocks` map keyed by:

- `authSource:refreshToken`

This prevents multiple simultaneous refreshes for the same token.

## 6. How imported accounts are stored

After import or OAuth success, Codex accounts are written into anti-api's unified auth store:

- `/Users/inkling/Desktop/anti-api/src/services/auth/store.ts`

Each account is stored as a `ProviderAccount` with:

- `provider = codex`
- `id`
- `email`
- `accessToken`
- `refreshToken`
- `expiresAt`
- `label`
- `authSource`

The auth store persists these accounts into anti-api's own data directory, independent from the original Codex files.

Additionally, anti-api writes a normalized proxy-style Codex auth file via:

- `saveCodexProxyAuthFile()`

This keeps a local mirror under `~/.cli-proxy-api`, which helps downstream compatibility and recovery.

## 7. How Codex proxying works at request time

### 7.1 Entry endpoints exposed by anti-api

anti-api accepts requests through standard compatibility endpoints:

- OpenAI style: `/v1/chat/completions`
- Anthropic style: `/v1/messages`
- also some compatibility aliases such as `/messages`

Those handlers eventually call routing:

- `createRoutedCompletion()`
- `createRoutedCompletionStream()`

### 7.2 Routing decides whether Codex should handle the request

In `/Users/inkling/Desktop/anti-api/src/services/routing/router.ts`, if a route entry or account route points to:

- `provider = codex`

then anti-api calls:

- `createCodexCompletion(account, model, messages, tools, maxTokens, reasoningEffort)`

This means Codex is not a separate HTTP server inside the app; it is one provider implementation inside the central routing layer.

## 8. Codex upstream endpoints used by the proxy

In `/Users/inkling/Desktop/anti-api/src/services/codex/chat.ts`, Codex requests are sent to ChatGPT backend endpoints.

Base:

- `https://chatgpt.com/backend-api/codex`

Important paths:

- `/responses`
- `/chat/completions`
- `/models`

Current implementation prefers `/responses` for all models.

### 8.1 Why `/responses` is preferred

Function:

- `shouldUseResponses(model)`

currently always returns `true`, so anti-api uses the ChatGPT backend Responses-style endpoint for Codex requests.

That path is closer to current Codex behavior and also supports reasoning configuration.

## 9. Request translation performed before proxying

The project converts anti-api's internal Claude-like message format into the format expected by ChatGPT Codex backend.

### 9.1 Message conversion

For `/responses`, anti-api uses:

- `toOpenAIMessages(...)`
- `toCodexResponsesInput(...)`

It converts:

- user messages -> `type: message` with `input_text`
- assistant tool calls -> separate `function_call` objects
- tool outputs -> `function_call_output` objects

### 9.2 Tool conversion

Tool schemas are converted by:

- `toOpenAITools(...)`

Then flattened into the Responses API shape:

- `type: function`
- `name`
- `description`
- `parameters`

### 9.3 Instructions and reasoning

anti-api extracts a system message and sends it as `instructions`.

It also includes:

- `parallel_tool_calls: true`
- `reasoning.effort`
- `reasoning.summary = auto`
- `include = ["reasoning.encrypted_content"]`

Reasoning effort is normalized to:

- `low`
- `medium`
- `high`

This is one of the key Codex-specific features already supported by the project.

## 10. Headers used for Codex proxying

When proxying Codex requests, anti-api builds Codex-specific headers that mimic expected Codex client traffic.

Examples include:

- `Authorization: Bearer <accessToken>`
- `Accept: text/event-stream`
- `Openai-Beta: responses=experimental`
- `Originator: codex_cli_rs`
- `User-Agent: codex_cli_rs/...`
- `Version: 0.21.0`
- `Chatgpt-Account-Id: <accountId>`

For model listing, a slightly different header set is used, still with:

- bearer auth
- `Chatgpt-Account-Id`
- Codex-style user agent

## 11. How the response is converted back

The ChatGPT Codex backend returns SSE-style content for `/responses`.

anti-api parses it using:

- `parseCodexSSEResponse()`

Then converts it into an OpenAI-like completion structure via:

- `buildCompletionFromResponses()`

Finally, `createCodexCompletion()` maps that result into anti-api's internal response shape:

- `contentBlocks`
- `stopReason`
- `usage`
- `resolvedModel`

That result can then be returned through:

- OpenAI-compatible responses
- Anthropic-compatible responses
- streaming or non-streaming flows

## 12. Model sync and support detection

anti-api also fetches live Codex model lists per account.

Function:

- `listCodexModelsForAccount(account)`

Endpoint:

- `GET https://chatgpt.com/backend-api/codex/models?client_version=...`

This is used by routing so the UI can show account-specific model availability.

The project also tracks unsupported models per account:

- `markCodexModelUnsupported(accountId, modelId)`
- `isCodexModelSupportedForAccount(accountId, modelId)`

This helps avoid repeatedly selecting models an account cannot access.

## 13. Failure handling and recovery

Codex support in anti-api includes several recovery paths.

### 13.1 Access token refresh

If Codex request returns auth-type failures (`401` / `403`), anti-api can:

1. try re-importing Codex auth sources
2. try refreshing the token
3. retry the request

### 13.2 Reuse-token edge case

If refresh fails due to a reused refresh token, anti-api:

- clears the stale refresh token
- re-checks saved local accounts
- tries imported auth sources again

### 13.3 Retry policy

Retryable statuses include:

- `429`
- `500`
- `502`
- `503`
- `504`
- `521`
- `522`
- `524`

Retries use exponential backoff with jitter.

### 13.4 TLS fallback

By default, Codex requests use normal TLS verification.

If the environment variable below is enabled:

- `ANTI_API_CODEX_INSECURE_TLS=1`

then anti-api can retry using insecure TLS mode for restricted or broken certificate environments.

This behavior exists in both:

- OAuth/token exchange logic
- Codex upstream request logic

## 14. What “Codex OAuth + proxy support” means in this repository

In practical terms, this repository supports Codex in four layers:

1. **Credential acquisition**
   - import from local Codex auth file
   - import from local proxy auth files
   - browser OAuth login via OpenAI auth

2. **Credential lifecycle**
   - refresh access tokens
   - persist imported accounts into anti-api
   - regenerate local proxy-style auth mirror

3. **Routing integration**
   - Codex accounts participate in flow routing and account routing
   - Codex model lists are fetched dynamically per account

4. **Protocol proxying**
   - anti-api accepts OpenAI/Anthropic-compatible requests
   - translates them to ChatGPT Codex backend format
   - sends them upstream with Codex-specific headers
   - parses upstream SSE output and returns normalized responses

## 15. Important limitations

This project does not implement a separate standalone Codex upstream protocol from scratch. It relies on:

- OpenAI OAuth endpoints for auth and refresh
- ChatGPT Codex backend endpoints for model listing and completions
- local credential artifacts from Codex CLI / proxy tooling when available

So the support is powerful, but it remains dependent on upstream behavior and may need updates whenever OpenAI changes:

- OAuth parameters
- token exchange behavior
- Codex backend headers
- response event format
- model availability behavior

## 16. Short summary

anti-api supports Codex by combining:

- local auth import (`~/.codex/auth.json`, `~/.cli-proxy-api/codex-*.json`)
- browser OAuth against `auth.openai.com`
- token refresh for both native and proxy-style credentials
- account persistence in anti-api's own auth store
- request translation to ChatGPT Codex backend `/responses`
- response normalization back into OpenAI/Anthropic-compatible APIs

That is why Codex in this project is both an **OAuth integration** and a **protocol proxy/provider implementation**.
