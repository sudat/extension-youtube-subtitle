# youtube-subtitle project overview
- Purpose: Chrome extension that overlays YouTube transcript text on the video and can translate grouped subtitles with Gemini.
- Stack: Chrome Extension Manifest V3, plain JavaScript, content script (`content.js`), service worker (`background.js`), page bridge (`page-bridge.js`).
- Structure: `content.js` handles transcript loading, overlay UI, playback sync, and translation queue. `background.js` calls Gemini. `page-bridge.js` reads YouTube player response from page context. `docs/design/subtitle-translation-overlay.md` contains feature design notes.
- Runtime: Loaded unpacked in Chrome via `chrome://extensions` on WSL workflows.