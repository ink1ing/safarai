# Release Process

## Goals

This project uses one stable release convention for all distributable builds:

- version tags use `vX.Y.Z`
- the app version maps to `MARKETING_VERSION = X.Y.Z`
- the app build maps to `CURRENT_PROJECT_VERSION`
- the distributable installer name uses:
  - `safarai-vX.Y.Z-buildN-macos.dmg`

Only signed, notarized, stapled `Release` builds should be uploaded as public releases.

## Required Credentials

Before publishing a distributable release, the local machine must have:

1. A valid `Developer ID Application` certificate in Keychain.
2. A valid notarytool keychain profile.
3. GitHub CLI authenticated if release upload is desired.

### Verify signing identity

```bash
security find-identity -v -p codesigning
```

You should see a non-revoked `Developer ID Application` identity.

### Configure notarytool profile

Create a profile once:

```bash
xcrun notarytool store-credentials "safarai-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "APP_SPECIFIC_PASSWORD"
```

Then export:

```bash
export APPLE_NOTARY_PROFILE="safarai-notary"
```

## Version Policy

Use semantic versioning:

- `X.Y.Z`
- bump `Z` for fixes
- bump `Y` for backward-compatible feature additions
- bump `X` for breaking behavioral or packaging changes

For every release:

1. Update `MARKETING_VERSION`.
2. Increment `CURRENT_PROJECT_VERSION`.
3. Add release notes at:
   - `docs/releases/vX.Y.Z.md`

## Build And Publish

The release script is:

- [`scripts/build_signed_release.sh`](/Users/silas/Desktop/safari%20ai/scripts/build_signed_release.sh)

It performs:

1. `Release` archive build
2. signature verification
3. DMG creation
4. notarization
5. stapling
6. optional GitHub release publish

### Local signed release

```bash
APPLE_NOTARY_PROFILE="safarai-notary" ./scripts/build_signed_release.sh
```

### Publish to GitHub release

```bash
APPLE_NOTARY_PROFILE="safarai-notary" PUBLISH_TO_GITHUB=1 ./scripts/build_signed_release.sh
```

## Release Notes Standard

Each release note file must include:

1. Summary
2. What changed
3. Installation / upgrade notes
4. Known issues
5. Rollback

Use the template in:

- [`docs/releases/TEMPLATE.md`](/Users/silas/Desktop/safari%20ai/docs/releases/TEMPLATE.md)

## Rollback Standard

Rollback must always be documented in the release notes.

Minimum rollback guidance:

1. Quit the current app.
2. Remove `/Applications/safarai.app`.
3. Reinstall the previous notarized DMG.
4. Re-open the app and verify Safari extension state.

## App Update Expectations

The in-app updater checks GitHub Releases and prefers installer assets named:

- `safarai-vX.Y.Z-buildN-macos.dmg`

Only non-draft, non-prerelease GitHub releases are treated as installable updates.
