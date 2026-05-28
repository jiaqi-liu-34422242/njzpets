# Releasing (GitHub Actions)

## macOS

This repo includes a GitHub Actions workflow that builds macOS artifacts on `macos-latest`.

### Option A: Manual build (recommended for first time)

1. Go to GitHub -> **Actions** -> **build-mac**
2. Click **Run workflow**
3. Wait for the run to finish
4. Download the artifacts `NewJeans-Pets-mac-arm64` and `NewJeans-Pets-mac-x64` from the run summary

### Option B: Tag build

Tag pushes matching `v*.*.*` trigger the mac build.

Example:

- Create tag `v1.0.1`
- Push the tag to GitHub
- Download `NewJeans-Pets-mac-arm64` and `NewJeans-Pets-mac-x64` from the Actions run

### Notes

- The workflow does not sign or notarize the app.
- macOS may show a Gatekeeper warning for unsigned apps. If you want a smoother install experience, you need Apple codesign + notarization (requires Apple Developer credentials and GitHub Secrets).
