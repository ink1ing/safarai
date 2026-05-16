# Safarai — Safari AI Assistant for macOS

Last verified: 2026-03-31

## Overview

Safarai is a local macOS AI assistant built around Safari. It ships as two tightly integrated pieces:

- **Host App** (`safarai`) — a native macOS app providing a floating chat panel, settings UI, account management, and all AI provider integrations
- **Safari Web Extension** (`safarai Extension`) — a browser extension that reads page content, tracks user selections, supports safe write-back into editable fields, and bridges to the host app via native messaging

The product goal is to bring AI-powered page understanding and safe content generation directly into the Safari browsing workflow, without ever automatically submitting forms or performing destructive page actions.

## Supported AI Providers

The app currently supports **three independent AI providers**, switchable from the Settings panel:

| Provider | Auth Mechanism | Implementation |
|---|---|---|
| **Codex** (OpenAI) | Browser-based OAuth with `localhost` callback | `CodexOAuthService`, `CodexResponseService`, `CodexModelService` |
| **GitHub Copilot** | GitHub Device Flow OAuth or local credential import | `CopilotOAuthService`, `CopilotResponseService` |
| **Zed** | Keychain import from Zed.app desktop client | `ZedAccountStore`, `ZedResponseService` |

All three providers support:

- Model list fetching and selection
- Streaming chat completions with page-aware prompt assembly
- Image attachment support (base64 / data URL)
- Multi-provider request format adaptation (Anthropic, OpenAI, Google, xAI)

The active provider is persisted via `ProviderSettingsStore` and shared across the app.

## Core Capabilities

### Page Understanding

- Site detection for GitHub, Gmail, X (Twitter), Yahoo Mail, YouTube, and general pages
- Content root scoring and article text extraction
- Structure summary, interactive element summary, and visual state extraction
- User selection tracking with intent-based forwarding to the panel
- Video page context extraction (YouTube and other platforms): title, author, duration, transcript, generated summaries

### Safe Writing

- Focused input detection (textarea, input, contenteditable)
- Site-specific selector fallback for comment boxes (GitHub, Gmail, X)
- Visual highlight of the target element before writing
- Draft injection with input event dispatch
- Clipboard copy fallback when direct write is not possible
- **Never** auto-submits, auto-clicks send, or auto-navigates

### Chat Panel

- Floating NSPanel with glassmorphism design, always-on-top mode
- Markdown rendering with code syntax highlighting
- Streaming response display with thinking/reasoning indicators
- Multi-turn conversation with page context injection
- Conversation thread management: create, rename, pin, delete
- Chat history persistence with customizable storage location (including security-scoped bookmarks)
- Export / import of full chat history library

### Agent Mode (Experimental)

- Safari automation tools: open tabs, read page content, extract data
- Tool-based agent loop with request/response bridge
- Agent activity UI with tool call visualization
- Early-stage — focused on read-safe operations

### Additional Features

- **In-app update**: checks GitHub Releases, downloads and opens DMG/ZIP installers
- **Multi-language**: English and Chinese, switchable at runtime via `AppLanguage`
- **Window placement**: remember, snap-left, snap-right with Safari window following
- **Custom system prompt** support via UI settings
- **Reasoning effort** control (low / medium / high) for Codex provider

## Repository Layout

```
safarai/
├── safarai.xcodeproj            # Main Xcode project
├── safarai/                     # macOS host app sources
│   ├── AppDelegate.swift
│   ├── ViewController.swift     # Main panel controller (~176K, core chat UI)
│   ├── FloatingPanelController.swift
│   ├── SettingsPanelController.swift
│   ├── PanelStateStore.swift    # State, threads, history, agent bridge
│   ├── CodexOAuthService.swift  # Codex OAuth flow
│   ├── CodexResponseService.swift
│   ├── CodexModelService.swift
│   ├── CopilotOAuthService.swift
│   ├── CopilotResponseService.swift
│   ├── ZedAccountStore.swift
│   ├── ZedResponseService.swift
│   ├── ProviderSettingsStore.swift
│   ├── WindowPlacementCoordinator.swift
│   ├── SafariContextRefresher.swift
│   ├── AppUpdateService.swift
│   ├── AppLanguage.swift
│   └── Resources/
│       ├── Panel.js             # Chat panel frontend (~79K)
│       └── Panel.css            # Panel styling (~35K)
└── safarai Extension/           # Safari Web Extension
    ├── SafariWebExtensionHandler.swift
    ├── NativeRouter.swift
    ├── LocalProviderClient.swift
    ├── ProviderConfig.swift
    └── Resources/
        ├── background.js        # Tab context, session, message orchestration (~96K)
        ├── content.js           # DOM reading, selection, write targets (~24K)
        ├── popup.html / .js / .css
        ├── manifest.json
        └── shared/
            ├── page-context.js  # Site detection, article extraction (~60K)
            ├── video-context.js # Video platform extraction (~43K)
            ├── write-target.js  # Safe editable resolution and writing
            ├── protocol.js      # Message protocol helpers
            ├── session-store.js # Session pruning
            └── log-store.js     # Log pruning
```

**Other top-level directories:**

- `tests/` — Node-based tests for shared JS modules
- `scripts/` — `build_signed_release.sh`, `package_beta.sh`
- `docs/` — `RELEASE.md` and per-version release notes
- `main.md` — original product direction
- `details.md` — original architecture / design notes
- `plans.md` — implementation status and next-step plan

## Testing

Run the shared JavaScript test suite with:

```bash
node --test tests/*.test.js
```

Verified on 2026-03-31:

- **33 tests passed**, 0 failed
- Coverage includes: protocol helpers, page-context extraction (including YouTube/video), session/log pruning, write-target behavior (GitHub, Gmail, X, contenteditable fallback, clipboard fallback)

## Development

### Open the project

Open in Xcode:

```
safarai/safarai.xcodeproj
```

### Build notes

- `package.json` is only used as a lightweight Node test workspace — the main app is **not** built with npm
- Xcode is the primary build tool; the app requires macOS 15+ (Sequoia) as the deployment target
- Command-line `xcodebuild` may fail at extension code-signing unless local signing is properly configured
- For signed release builds, see `docs/RELEASE.md` and `scripts/build_signed_release.sh`

### First-time setup

1. Open the Xcode project
2. Ensure signing identity is configured for both `safarai` and `safarai Extension` targets
3. Build and run the `safarai` scheme
4. Enable the Safari extension in **Safari → Settings → Extensions**
5. Log into your preferred AI provider via the Settings panel in the host app

## Architecture Notes

### Communication Flow

```
Safari Page
  └─ content.js (DOM reading, selection, write actions)
       └─ background.js (tab context cache, session, message routing)
            ├─ popup (minimal account status UI)
            └─ Native Messaging → SafariWebExtensionHandler
                 └─ NativeRouter → Host App Services
                      ├─ CodexResponseService (streaming)
                      ├─ CopilotResponseService (streaming)
                      ├─ ZedResponseService (streaming)
                      └─ PanelStateStore (state sync)

Host App (floating panel)
  └─ ViewController + Panel.js
       ├─ Direct provider calls for panel-initiated questions
       ├─ Chat history thread management
       └─ Agent bridge for tool-based workflows
```

### Provider Architecture

Each provider has its own account store, OAuth/auth service, and response service. The `ActiveProvider` enum and `ProviderSettingsStore` determine which backend handles requests. The extension-side `LocalProviderClient` currently handles Codex requests directly; Copilot and Zed are served from the host app panel.

### State Sharing

The host app and extension share state through an App Group container (`SharedContainer.baseURL()`), using JSON files:

- `panel-state.json` — current page context, messages, status
- `codex-account.json` / `copilot-account.json` / `zed-account.json` — provider credentials
- `active-provider.json` — which provider is active
- `ui-settings.json` — language, placement mode, reasoning effort, custom system prompt, history storage
- `chat-history/` — thread index and individual thread records

## Known Limitations

- Provider logic (Codex/Copilot/Zed) is not yet consolidated behind a single unified adapter interface — each provider has its own complete service
- Some account/model code is still duplicated between the app and extension targets
- End-to-end automated testing does not yet cover full app or extension flows
- Video transcript extraction depends on platform availability and may not succeed on all pages
- Agent mode is experimental and limited to read-safe Safari operations

## Roadmap

See `plans.md` for the detailed next-step plan. The recommended priority order is:

1. **Product scope**: decide on panel-first vs. sidebar-first vs. both
2. **Provider consolidation**: unify Codex/Copilot/Zed behind a common adapter boundary
3. **Site-level regression**: systematic verification across GitHub, Gmail, X, Yahoo Mail
4. **Build reproducibility**: clean up signing and CI for consistent distributable builds
5. **Extended features**: richer agent workflows, more sites, advanced chat capabilities
