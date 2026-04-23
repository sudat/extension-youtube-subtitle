# Repository Guidelines

## Project Structure & Module Organization
This repository is a plain JavaScript Chrome extension with no build step. Runtime files live at the root: `manifest.json` defines the MV3 entry points, `content.js` renders and updates the YouTube overlay UI, `transcript-sync.js` contains transcript timing/grouping helpers, `subtitle-copy.js` builds copy-ready transcript text, `background.js` handles translation API calls, and `page-bridge.js` reads player data from the page context. Tests live in `tests/`, and longer design notes live in `docs/design/`.

## Build, Test, and Development Commands
- `node --test tests/*.test.js` runs the full automated test suite.
- `node --test tests/transcript-sync.test.js` checks transcript parsing, grouping, and timing logic.
- `node --test tests/subtitle-copy.test.js` checks plain transcript copy text generation.
- `chrome://extensions/` loads this folder as an unpacked extension for manual verification on YouTube.

There is no bundler, package manifest, or lint task today, so keep changes runnable as browser-ready JavaScript files.

## Coding Style & Naming Conventions
Match the existing style: 2-space indentation, small focused helpers, and no unnecessary abstractions. Prefer `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for shared constants, and behavior-based filenames such as `transcript-sync.js`. Reuse existing module boundaries instead of moving logic between `content.js` and `background.js` unless the behavior truly changes.

## Testing Guidelines
Tests use Node’s built-in `node:test` runner with `node:assert/strict`. Add or update `tests/*.test.js` whenever you change transcript normalization, active subtitle selection, copy formatting, or provider response parsing. Name tests after behavior, for example `findActiveGroupedIndex clears the overlay during a long explicit gap`.

## Commit & Pull Request Guidelines
Recent commits use short, focused subjects like `subtitle offset fix`, `delete panel fallback`, and `bugfix:subtitle-box`. Keep commits narrow and descriptive. Pull requests should include a brief user-facing summary, linked issue or task when available, test commands with results, and screenshots or recordings for overlay/settings UI changes.

## Security & Configuration Tips
Translation settings store API keys in `chrome.storage.local`; never commit real credentials. Keep new host permissions in `manifest.json` as narrow as possible. When changing YouTube selectors or transcript loading behavior, verify the unpacked extension on a real watch page and confirm there are no console errors.
