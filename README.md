# Safari AI Sidebar

Last verified: 2026-03-25

## Overview

This repository contains a local macOS Safari AI assistant built as:

- a macOS host app (`safarai`)
- a Safari Web Extension (`safarai Extension`)
- shared JavaScript modules for page understanding and safe write actions

The original product goal was a Safari sidebar-first assistant for reading the current page and writing drafts into the currently focused input. The codebase has already moved beyond that minimal scope: today the host app also provides a standalone desktop panel with chat history, attachments, theme/language settings, and an early page-agent workflow.

## Current State

The project is no longer just a design skeleton. The following pieces already exist in code:

- Xcode project with app target `safarai` and extension target `safarai Extension`
- Safari extension background/content scripts and a browser action popup
- shared page-context extraction for GitHub, Gmail, X, and Yahoo Mail
- safe write-target detection, highlight, apply, and clipboard fallback
- native bridge from the extension into the host app
- Codex OAuth in the host app using a local callback listener
- Codex model refresh and streaming response handling
- standalone panel UI in the host app with chat history and agent-related UI state

What is still incomplete or inconsistent with the original design:

- the architecture is not yet fully centered on a replaceable local HTTP provider boundary
- Codex request logic exists directly in Swift services instead of being isolated behind a clean provider adapter
- account/model/OAuth logic is duplicated across the app and extension targets
- automated coverage is currently focused on shared JavaScript modules, not end-to-end app or extension flows
- command-line `xcodebuild` currently reaches a code-signing failure for the extension in this workspace, so local signing setup still needs cleanup

## Repository Layout

- `safarai/safarai.xcodeproj`: main Xcode project
- `safarai/safarai/`: macOS host app sources
- `safarai/safarai Extension/`: Safari Web Extension sources and native-message bridge
- `safarai/safarai Extension/Resources/shared/`: shared JS modules for protocol, page extraction, write targets, session/log storage
- `tests/`: Node-based tests for shared JS behavior
- `main.md`: original product direction
- `details.md`: original architecture/design notes
- `plans.md`: implementation status and next-step plan

## Key Implemented Components

### Browser side

- `background.js`
  - tab context cache
  - session/log storage
  - popup/content/native message orchestration
  - panel state sync
- `content.js`
  - page context extraction
  - selection tracking
  - write target preparation and draft application
  - interactive target actions such as highlight/focus/scroll/click
- `shared/page-context.js`
  - site detection
  - content root scoring
  - article extraction
  - structure summary
  - interactive target indexing
  - page visual state extraction
- `shared/write-target.js`
  - safe editable target resolution
  - site-specific selectors
  - page highlight
  - draft injection
  - clipboard fallback

### Host app side

- `CodexOAuthService.swift`
  - browser OAuth
  - localhost callback server
  - token exchange and refresh
- `CodexModelService.swift`
  - model list fetch from Codex backend
- `CodexResponseService.swift`
  - streaming responses
  - page-aware prompt assembly
  - early agent/tool response handling
- `ViewController.swift` + `Resources/Panel.js`
  - standalone panel UI
  - history/settings/provider actions
  - message streaming and agent UI state
- `SafariWebExtensionHandler.swift` + `NativeRouter.swift`
  - extension native messaging entrypoint
  - routing into host actions and provider calls

## Testing

The repository currently includes Node tests for shared JavaScript behavior.

Run them with:

```bash
node --test tests/*.test.js
```

Verified on 2026-03-25:

- 23 tests passed
- coverage includes protocol helpers, page-context extraction, session/log pruning, and write-target behavior

## Development Notes

### Open the app project

Use Xcode and open:

```text
safarai/safarai.xcodeproj
```

### Build notes

- `package.json` is only used as a lightweight Node test workspace
- the main app is not built with npm/pnpm/yarn
- a plain command-line build currently fails at extension code signing in this workspace, so signing should be checked in Xcode before relying on CLI builds

## Recommended Next Work

The current highest-value cleanup items are:

1. Decide whether the product should stay panel-first, sidebar-first, or support both explicitly.
2. Consolidate Codex provider logic behind one replaceable provider boundary.
3. Remove duplicated account/OAuth/model code between app and extension targets.
4. Add end-to-end verification for page extraction, draft generation, and write confirmation on the four target sites.
5. Clean up local signing/build so the project can be built reproducibly outside the current machine state.
