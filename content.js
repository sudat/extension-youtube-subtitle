(() => {
  const ROOT_ID = 'yt-transcript-overlay-root';
  const BRIDGE_ID = 'yt-transcript-overlay-bridge';
  const RESPONSE_EVENT = 'yt-transcript-overlay:player-response';
  const REQUEST_EVENT = 'yt-transcript-overlay:request-player-response';
  const NAV_EVENT = 'yt-transcript-overlay:navigation';
  const DISPLAY_GROUP_SIZE = 5;
  const TRANSLATION_WINDOW_SIZE = 5;

  const DEFAULT_SETTINGS = {
    enabled: true,
    fontSize: 28,
    maxWidthPct: 78,
    bgOpacity: 0.42,
    xPct: 50,
    yPct: 84,
    showStatus: true,
    translationEnabled: false,
    translationApiKey: '',
    translationModel: 'gemini-3.1-flash-lite-preview'
  };

  const state = {
    url: location.href,
    videoId: null,
    rawSegments: [],
    groupedSegments: [],
    activeIndex: -1,
    activeText: '',
    settings: { ...DEFAULT_SETTINGS },
    ui: null,
    syncTimer: null,
    navTimer: null,
    transcriptRequestId: 0,
    booted: false,
    currentTrackLabel: '',
    currentTranscriptMeta: null,
    dragging: null,
    statusDragging: null,
    formDraft: {
      translationApiKey: '',
      translationModel: DEFAULT_SETTINGS.translationModel
    },
    status: {
      transcriptText: '',
      transcriptError: false,
      translationText: '',
      translationError: false
    },
    statusUi: {
      signature: '',
      expanded: false,
      collapseTimer: null
    },
    translation: {
      requestKey: '',
      windows: [],
      queue: [],
      inFlight: null,
      completedCount: 0,
      totalCount: 0,
      errorCount: 0,
      priorityWindowIndex: null
    }
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    console.debug('[YT Transcript Overlay]', ...args);
  }

  function injectBridge() {
    if (document.getElementById(BRIDGE_ID)) return;
    const script = document.createElement('script');
    script.id = BRIDGE_ID;
    script.src = chrome.runtime.getURL('page-bridge.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function getVideoIdFromUrl(url = location.href) {
    try {
      const u = new URL(url);
      if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const shorts = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shorts) return shorts[1];
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  function isWatchLikeUrl(url = location.href) {
    return /youtube\.com\/(watch|shorts)/.test(url) || /youtu\.be\//.test(url);
  }

  function getVideoEl() {
    return document.querySelector('video');
  }

  function getPlayerEl() {
    return (
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.querySelector('ytd-player #container') ||
      document.querySelector('#player-container')
    );
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    state.settings = { ...DEFAULT_SETTINGS, ...stored };
    if (
      state.settings.translationModel === 'gemini-3.1-flash-lite' ||
      state.settings.translationModel === 'gemini-2.5-flash-lite'
    ) {
      state.settings.translationModel = DEFAULT_SETTINGS.translationModel;
      try {
        await chrome.storage.local.set({ translationModel: DEFAULT_SETTINGS.translationModel });
      } catch {}
    }
    state.formDraft.translationApiKey = state.settings.translationApiKey || '';
    state.formDraft.translationModel = state.settings.translationModel || DEFAULT_SETTINGS.translationModel;
  }

  function saveSettings(partial) {
    state.settings = { ...state.settings, ...partial };
    try {
      chrome.storage.local.set(partial);
    } catch {}
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function sanitizeText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseTimestampText(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return null;
    const match = cleaned.match(/(\d{1,2}:)?\d{1,2}:\d{2}/);
    if (!match) return null;
    const parts = match[0].split(':').map((x) => Number(x));
    if (parts.some(Number.isNaN)) return null;
    let sec = 0;
    if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) sec = parts[0] * 60 + parts[1];
    return sec * 1000;
  }

  function textFromName(name) {
    if (!name) return '';
    if (typeof name.simpleText === 'string') return name.simpleText;
    if (Array.isArray(name.runs)) return name.runs.map((x) => x.text || '').join('');
    return '';
  }

  function getTrackLabel(track) {
    return sanitizeText(textFromName(track?.name));
  }

  function isJapaneseLanguageCode(languageCode) {
    return /^ja(?:[-_]|$)/i.test(String(languageCode || '').trim());
  }

  function isJapaneseAutoGeneratedTrack(track) {
    if (!track || typeof track !== 'object') return false;
    const label = getTrackLabel(track).toLowerCase();
    const kind = String(track.kind || '').toLowerCase();
    const vssId = String(track.vssId || '').toLowerCase();
    const looksJapanese =
      isJapaneseLanguageCode(track.languageCode) ||
      label.includes('日本語') ||
      label.includes('にほんご') ||
      label.includes('japanese') ||
      vssId.includes('.ja');
    const looksAutoGenerated =
      kind === 'asr' ||
      label.includes('自動生成') ||
      label.includes('auto-generated');
    return looksJapanese && looksAutoGenerated;
  }

  function buildTranscriptMeta(source, track = null) {
    const label = getTrackLabel(track) || sanitizeText(source || '');
    const shouldHideOverlay = isJapaneseAutoGeneratedTrack(track);
    return {
      source: sanitizeText(source || ''),
      label,
      languageCode: sanitizeText(track?.languageCode || ''),
      kind: sanitizeText(track?.kind || ''),
      isAutoGenerated: String(track?.kind || '').toLowerCase() === 'asr',
      shouldHideOverlay,
      shouldSkipTranslation: shouldHideOverlay,
      skipReason: shouldHideOverlay ? 'メイン字幕が日本語（自動生成）のためオーバーレイを表示しません。' : ''
    };
  }

  function setStatusParts(partial) {
    state.status = {
      ...state.status,
      ...partial
    };
    renderStatus();
  }

  function clearStatusCollapseTimer() {
    if (!state.statusUi.collapseTimer) return;
    clearTimeout(state.statusUi.collapseTimer);
    state.statusUi.collapseTimer = null;
  }

  function scheduleStatusCollapse() {
    clearStatusCollapseTimer();
    state.statusUi.collapseTimer = window.setTimeout(() => {
      state.statusUi.expanded = false;
      renderStatus();
    }, 10000);
  }

  function setStatusExpanded(expanded, options = {}) {
    state.statusUi.expanded = expanded;
    if (expanded && options.autoCollapse) {
      scheduleStatusCollapse();
    } else if (!expanded) {
      clearStatusCollapseTimer();
    }
    renderStatus();
  }

  function renderStatus() {
    const ui = state.ui;
    if (!ui?.statusShell || !ui?.statusBubble || !ui?.statusIcon) return;

    const parts = [];
    if (state.status.transcriptText) parts.push(state.status.transcriptText);
    if (state.status.translationText) parts.push(state.status.translationText);
    const text = parts.join('\n');
    const hasError = state.status.transcriptError || state.status.translationError;
    const signature = `${hasError ? 'error' : 'ok'}:${text}`;
    const previousSignature = state.statusUi.signature;
    const previousHadError = previousSignature.startsWith('error:');
    const hadVisibleMessage = Boolean(previousSignature);
    const previousTranscriptText = state.statusUi.previousTranscriptText || '';
    const transcriptTextChanged = previousTranscriptText !== state.status.transcriptText;

    if (signature !== state.statusUi.signature) {
      state.statusUi.signature = signature;
      if (text) {
        const shouldAutoExpand =
          !hadVisibleMessage ||
          (!previousHadError && hasError) ||
          (transcriptTextChanged && (
            state.status.transcriptText.includes('読み込んでいます') ||
            state.status.transcriptText.includes('読み込みました')
          ));

        if (shouldAutoExpand) {
          state.statusUi.expanded = true;
        }
        if (!hasError && shouldAutoExpand) {
          scheduleStatusCollapse();
        } else if (hasError) {
          clearStatusCollapseTimer();
        }
      } else {
        state.statusUi.expanded = false;
        clearStatusCollapseTimer();
      }
    }
    state.statusUi.previousTranscriptText = state.status.transcriptText;

    ui.statusBubble.textContent = text;
    ui.statusShell.dataset.error = hasError ? '1' : '0';
    ui.statusIcon.textContent = hasError ? '!' : 'i';
    ui.statusShell.dataset.expanded = state.statusUi.expanded ? '1' : '0';
    ui.statusShell.style.display = state.settings.showStatus && parts.length ? 'block' : 'none';
  }

  function ensureUi() {
    const player = getPlayerEl();
    if (!player) return null;

    if (state.ui?.root?.isConnected && state.ui.root.parentElement === player) {
      applySettingsToUi();
      return state.ui;
    }

    state.ui?.root?.remove();

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <style>
        #${ROOT_ID} {
          position: absolute;
          inset: 0;
          z-index: 60;
          pointer-events: none;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        #${ROOT_ID} * { box-sizing: border-box; }
        #${ROOT_ID} .yto-status-shell {
          position: absolute;
          left: 12px;
          top: 12px;
          width: 22px;
          height: 22px;
          pointer-events: auto;
          user-select: none;
        }
        #${ROOT_ID} .yto-status {
          position: absolute;
          left: 0;
          top: 30px;
          width: min(360px, 56vw);
          max-width: min(360px, 56vw);
          padding: 6px 10px;
          border-radius: 10px;
          background: rgba(15, 15, 15, 0.78);
          color: rgba(255,255,255,0.92);
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-word;
          pointer-events: auto;
          user-select: text;
          cursor: text;
          box-shadow: 0 10px 26px rgba(0,0,0,0.28);
          opacity: 0;
          visibility: hidden;
          transform: translateY(-4px);
          transition: opacity 160ms ease, transform 160ms ease, visibility 160ms ease;
        }
        #${ROOT_ID} .yto-status-shell[data-expanded="1"] .yto-status,
        #${ROOT_ID} .yto-status-shell:hover .yto-status,
        #${ROOT_ID} .yto-status-shell:focus-within .yto-status {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
        }
        #${ROOT_ID} .yto-status-shell[data-error="1"] .yto-status {
          background: rgba(120, 0, 0, 0.82);
        }
        #${ROOT_ID} .yto-status-shell.is-dragging .yto-status-icon {
          cursor: grabbing;
          transform: scale(1.04);
        }
        #${ROOT_ID} .yto-status-icon {
          appearance: none;
          -webkit-appearance: none;
          width: 22px;
          height: 22px;
          border: 0;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: rgba(15, 15, 15, 0.55);
          color: rgba(255,255,255,0.92);
          font-size: 12px;
          font-weight: 700;
          cursor: grab;
          pointer-events: auto;
          box-shadow: 0 6px 16px rgba(0,0,0,0.22);
          opacity: 0.72;
          transition: opacity 160ms ease, transform 160ms ease, background 160ms ease;
        }
        #${ROOT_ID} .yto-status-shell:hover .yto-status-icon,
        #${ROOT_ID} .yto-status-shell[data-expanded="1"] .yto-status-icon {
          opacity: 0.96;
        }
        #${ROOT_ID} .yto-status-shell[data-error="1"] .yto-status-icon {
          background: rgba(180, 28, 28, 0.92);
          color: #fff;
        }
        #${ROOT_ID} .yto-gear {
          position: absolute;
          right: 12px;
          top: 12px;
          width: 34px;
          height: 34px;
          border: 0;
          border-radius: 999px;
          background: rgba(15, 15, 15, 0.72);
          color: #fff;
          cursor: pointer;
          pointer-events: auto;
          font-size: 16px;
        }
        #${ROOT_ID} .yto-gear:hover {
          background: rgba(15, 15, 15, 0.9);
        }
        #${ROOT_ID} .yto-panel {
          position: absolute;
          right: 12px;
          top: 54px;
          width: 260px;
          max-height: min(70vh, 520px);
          overflow: auto;
          padding: 12px;
          border-radius: 14px;
          background: rgba(15, 15, 15, 0.88);
          color: #fff;
          display: none;
          pointer-events: auto;
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        }
        #${ROOT_ID} .yto-panel.is-open { display: block; }
        #${ROOT_ID} .yto-row {
          display: grid;
          gap: 4px;
          margin-bottom: 10px;
          font-size: 12px;
        }
        #${ROOT_ID} .yto-row:last-child { margin-bottom: 0; }
        #${ROOT_ID} .yto-row-title {
          font-weight: 600;
        }
        #${ROOT_ID} .yto-section-toggle {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          font-size: 12px;
          font-weight: 600;
          text-align: left;
        }
        #${ROOT_ID} .yto-section-toggle::after {
          content: '▾';
          font-size: 11px;
          opacity: 0.8;
          transform: rotate(-90deg);
          transition: transform 160ms ease;
        }
        #${ROOT_ID} .yto-section-toggle[data-expanded="1"]::after {
          transform: rotate(0deg);
        }
        #${ROOT_ID} .yto-section-body {
          display: none;
          padding-top: 10px;
        }
        #${ROOT_ID} .yto-section-body.is-open {
          display: block;
        }
        #${ROOT_ID} .yto-panel input[type="range"] { width: 100%; }
        #${ROOT_ID} .yto-panel input[type="text"],
        #${ROOT_ID} .yto-panel input[type="password"] {
          width: 100%;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 10px;
          padding: 8px 10px;
          background: rgba(255,255,255,0.08);
          color: #fff;
        }
        #${ROOT_ID} .yto-panel input::placeholder {
          color: rgba(255,255,255,0.55);
        }
        #${ROOT_ID} .yto-panel button {
          border: 0;
          border-radius: 10px;
          padding: 8px 10px;
          background: rgba(255,255,255,0.1);
          color: #fff;
          cursor: pointer;
        }
        #${ROOT_ID} .yto-panel button:hover {
          background: rgba(255,255,255,0.18);
        }
        #${ROOT_ID} .yto-divider {
          height: 1px;
          margin: 12px 0;
          background: rgba(255,255,255,0.12);
        }
        #${ROOT_ID} .yto-inline {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        #${ROOT_ID} .yto-note {
          color: rgba(255,255,255,0.68);
          font-size: 11px;
          line-height: 1.4;
        }
        #${ROOT_ID} .yto-actions {
          display: grid;
          gap: 8px;
          margin-bottom: 10px;
        }
        #${ROOT_ID} .yto-save {
          background: rgba(106, 170, 255, 0.22);
        }
        #${ROOT_ID} .yto-save:hover {
          background: rgba(106, 170, 255, 0.34);
        }
        #${ROOT_ID} .yto-subtitle {
          position: absolute;
          left: 50%;
          top: 84%;
          transform: translate(-50%, -50%);
          max-width: 78%;
          padding: 8px 14px;
          border-radius: 14px;
          background: rgba(0,0,0,0.42);
          color: #fff;
          text-align: center;
          line-height: 1.45;
          font-size: 28px;
          font-weight: 700;
          text-shadow:
            0 1px 2px rgba(0,0,0,0.95),
            0 2px 6px rgba(0,0,0,0.95),
            0 0 16px rgba(0,0,0,0.65);
          pointer-events: auto;
          cursor: grab;
          user-select: none;
          white-space: pre-wrap;
          word-break: break-word;
          touch-action: none;
        }
        #${ROOT_ID} .yto-subtitle.is-empty {
          display: none;
        }
        #${ROOT_ID} .yto-subtitle.is-dragging {
          cursor: grabbing;
          outline: 2px solid rgba(255,255,255,0.35);
        }
      </style>
      <div class="yto-status-shell" data-expanded="0" data-error="0">
        <button class="yto-status-icon" type="button" aria-label="Status">i</button>
        <div class="yto-status"></div>
      </div>
      <button class="yto-gear" type="button" title="字幕設定">⚙</button>
      <div class="yto-panel">
        <label class="yto-row">
          <span class="yto-row-title">文字サイズ</span>
          <input class="yto-font" type="range" min="18" max="44" step="1" />
        </label>
        <label class="yto-row">
          <span class="yto-row-title">背景の濃さ</span>
          <input class="yto-bg" type="range" min="0" max="0.9" step="0.02" />
        </label>
        <label class="yto-row">
          <span class="yto-row-title">幅</span>
          <input class="yto-width" type="range" min="40" max="95" step="1" />
        </label>
        <div class="yto-divider"></div>
        <div class="yto-row">
          <button class="yto-section-toggle yto-translation-toggle" type="button" data-expanded="0">翻訳設定</button>
          <div class="yto-section-body yto-translation-section">
            <label class="yto-row">
              <span class="yto-inline">
                <input class="yto-translation-enabled" type="checkbox" />
                <span class="yto-row-title">翻訳を有効化</span>
              </span>
            </label>
            <label class="yto-row">
              <span class="yto-row-title">Gemini API Key</span>
              <input class="yto-api-key" type="password" placeholder="AIza..." autocomplete="off" />
            </label>
            <label class="yto-row">
              <span class="yto-row-title">Gemini Model</span>
              <input class="yto-model" type="text" placeholder="gemini-3.1-flash-lite-preview" />
            </label>
            <div class="yto-actions">
              <button class="yto-save" type="button">翻訳設定を保存</button>
            </div>
            <div class="yto-note">翻訳は5ブロック単位で順番に実行します。未翻訳の区間は原文を暫定表示します。</div>
          </div>
        </div>
        <div class="yto-divider"></div>
        <button class="yto-reset" type="button">位置をリセット</button>
      </div>
      <div class="yto-subtitle is-empty"></div>
    `;

    if (getComputedStyle(player).position === 'static') {
      player.style.position = 'relative';
    }
    player.appendChild(root);

    const ui = {
      root,
      statusShell: root.querySelector('.yto-status-shell'),
      statusIcon: root.querySelector('.yto-status-icon'),
      statusBubble: root.querySelector('.yto-status'),
      gear: root.querySelector('.yto-gear'),
      panel: root.querySelector('.yto-panel'),
      subtitle: root.querySelector('.yto-subtitle'),
      font: root.querySelector('.yto-font'),
      bg: root.querySelector('.yto-bg'),
      width: root.querySelector('.yto-width'),
      translationToggle: root.querySelector('.yto-translation-toggle'),
      translationSection: root.querySelector('.yto-translation-section'),
      translationEnabled: root.querySelector('.yto-translation-enabled'),
      apiKey: root.querySelector('.yto-api-key'),
      model: root.querySelector('.yto-model'),
      save: root.querySelector('.yto-save'),
      reset: root.querySelector('.yto-reset')
    };

    bindUi(ui);
    state.ui = ui;
    applySettingsToUi();
    renderStatus();
    return ui;
  }

  function applySettingsToUi() {
    const ui = state.ui;
    if (!ui?.root) return;
    ui.subtitle.style.fontSize = `${state.settings.fontSize}px`;
    ui.subtitle.style.maxWidth = `${state.settings.maxWidthPct}%`;
    ui.subtitle.style.background = `rgba(0, 0, 0, ${state.settings.bgOpacity})`;
    ui.subtitle.style.left = `${state.settings.xPct}%`;
    ui.subtitle.style.top = `${state.settings.yPct}%`;
    ui.root.style.display = state.settings.enabled ? 'block' : 'none';
    ui.font.value = String(state.settings.fontSize);
    ui.bg.value = String(state.settings.bgOpacity);
    ui.width.value = String(state.settings.maxWidthPct);
    ui.translationEnabled.checked = Boolean(state.settings.translationEnabled);
    if (document.activeElement !== ui.apiKey) {
      ui.apiKey.value = state.formDraft.translationApiKey;
    }
    if (document.activeElement !== ui.model) {
      ui.model.value = state.formDraft.translationModel;
    }
    renderStatus();
  }

  function setTranslationSectionExpanded(expanded) {
    const ui = state.ui;
    if (!ui?.translationToggle || !ui?.translationSection) return;
    ui.translationToggle.dataset.expanded = expanded ? '1' : '0';
    ui.translationSection.classList.toggle('is-open', expanded);
  }

  function resetPosition() {
    saveSettings({ xPct: DEFAULT_SETTINGS.xPct, yPct: DEFAULT_SETTINGS.yPct });
    applySettingsToUi();
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function queueTranslationRestart() {
    if (!state.groupedSegments.length) {
      setStatusParts({
        translationText: state.settings.translationEnabled ? '翻訳対象の字幕がまだ読み込まれていません。' : '',
        translationError: false
      });
      syncSubtitle();
      return;
    }
    setupTranslationState();
    syncSubtitle();
  }

  async function persistSettings(partial) {
    state.settings = { ...state.settings, ...partial };
    try {
      await chrome.storage.local.set(partial);
    } catch {}
  }

  async function persistTranslationSettings() {
    const translationApiKey = sanitizeText(state.formDraft.translationApiKey);
    const translationModel = sanitizeText(state.formDraft.translationModel) || DEFAULT_SETTINGS.translationModel;
    await persistSettings({
      translationApiKey,
      translationModel
    });
    state.formDraft.translationApiKey = translationApiKey;
    state.formDraft.translationModel = translationModel;
    setTranslationStatus('翻訳設定を保存しました。', false);
    applySettingsToUi();
    queueTranslationRestart();
  }

  function bindUi(ui) {
    ui.gear.addEventListener('click', () => {
      ui.panel.classList.toggle('is-open');
    });

    ui.translationToggle.addEventListener('click', () => {
      const expanded = ui.translationToggle.dataset.expanded === '1';
      setTranslationSectionExpanded(!expanded);
    });

    ui.font.addEventListener('input', () => {
      saveSettings({ fontSize: Number(ui.font.value) });
      applySettingsToUi();
    });
    ui.bg.addEventListener('input', () => {
      saveSettings({ bgOpacity: Number(ui.bg.value) });
      applySettingsToUi();
    });
    ui.width.addEventListener('input', () => {
      saveSettings({ maxWidthPct: Number(ui.width.value) });
      applySettingsToUi();
    });
    ui.translationEnabled.addEventListener('change', async () => {
      await persistSettings({ translationEnabled: ui.translationEnabled.checked });
      queueTranslationRestart();
    });
    ui.apiKey.addEventListener('input', () => {
      state.formDraft.translationApiKey = ui.apiKey.value;
    });
    ui.model.addEventListener('input', () => {
      state.formDraft.translationModel = ui.model.value;
    });
    ui.apiKey.addEventListener('change', () => {
      state.formDraft.translationApiKey = ui.apiKey.value;
    });
    ui.model.addEventListener('change', () => {
      state.formDraft.translationModel = ui.model.value;
    });
    ui.apiKey.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await persistTranslationSettings();
    });
    ui.model.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await persistTranslationSettings();
    });
    ui.save.addEventListener('click', async () => {
      await persistTranslationSettings();
    });
    ui.reset.addEventListener('click', resetPosition);

    ui.statusIcon.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setStatusExpanded(!state.statusUi.expanded, {
        autoCollapse: !state.statusUi.expanded && !(state.status.transcriptError || state.status.translationError)
      });
    });

    ui.statusShell.addEventListener('mouseenter', () => {
      if (!state.statusUi.expanded) {
        clearStatusCollapseTimer();
        renderStatus();
      }
    });

    ui.statusShell.addEventListener('mouseleave', () => {
      if (!state.statusUi.expanded && !(state.status.transcriptError || state.status.translationError)) {
        scheduleStatusCollapse();
      }
      renderStatus();
    });

    ui.statusIcon.addEventListener('pointerdown', (event) => {
      const selection = window.getSelection?.();
      if (selection && String(selection).trim()) return;
      if (event.button !== 0) return;
      const player = getPlayerEl();
      if (!player) return;
      const playerRect = player.getBoundingClientRect();
      const statusRect = ui.statusShell.getBoundingClientRect();
      state.statusDragging = {
        pointerId: event.pointerId,
        playerRect,
        offsetX: event.clientX - statusRect.left,
        offsetY: event.clientY - statusRect.top
      };
      ui.statusShell.classList.add('is-dragging');
      ui.statusIcon.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    ui.statusIcon.addEventListener('pointermove', (event) => {
      if (!state.statusDragging || state.statusDragging.pointerId !== event.pointerId) return;
      const { playerRect, offsetX, offsetY } = state.statusDragging;
      const shellWidth = ui.statusIcon.offsetWidth || 22;
      const shellHeight = ui.statusIcon.offsetHeight || 22;
      const maxLeft = Math.max(12, playerRect.width - shellWidth - 12);
      const maxTop = Math.max(12, playerRect.height - shellHeight - 12);
      const left = clamp(event.clientX - playerRect.left - offsetX, 12, maxLeft);
      const top = clamp(event.clientY - playerRect.top - offsetY, 12, maxTop);
      ui.statusShell.style.left = `${left}px`;
      ui.statusShell.style.top = `${top}px`;
      event.preventDefault();
    });

    function stopStatusDragging(event) {
      if (!state.statusDragging) return;
      if (event && state.statusDragging.pointerId != null && event.pointerId != null && state.statusDragging.pointerId !== event.pointerId) return;
      ui.statusShell.classList.remove('is-dragging');
      state.statusDragging = null;
    }

    ui.statusIcon.addEventListener('pointerup', stopStatusDragging);
    ui.statusIcon.addEventListener('pointercancel', stopStatusDragging);

    ui.subtitle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      resetPosition();
    });

    ui.subtitle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const player = getPlayerEl();
      if (!player) return;
      const rect = player.getBoundingClientRect();
      state.dragging = {
        pointerId: event.pointerId,
        rect
      };
      ui.subtitle.classList.add('is-dragging');
      ui.subtitle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    ui.subtitle.addEventListener('pointermove', (event) => {
      if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
      const rect = state.dragging.rect;
      const xPct = clamp(((event.clientX - rect.left) / rect.width) * 100, 5, 95);
      const yPct = clamp(((event.clientY - rect.top) / rect.height) * 100, 5, 95);
      state.settings.xPct = xPct;
      state.settings.yPct = yPct;
      applySettingsToUi();
      event.preventDefault();
    });

    function stopDragging(event) {
      if (!state.dragging) return;
      if (event && state.dragging.pointerId != null && event.pointerId != null && state.dragging.pointerId !== event.pointerId) return;
      ui.subtitle.classList.remove('is-dragging');
      saveSettings({ xPct: state.settings.xPct, yPct: state.settings.yPct });
      state.dragging = null;
    }

    ui.subtitle.addEventListener('pointerup', stopDragging);
    ui.subtitle.addEventListener('pointercancel', stopDragging);

    document.addEventListener('click', (event) => {
      if (!ui.panel.classList.contains('is-open')) return;
      if (event.target.closest(`#${ROOT_ID} .yto-panel`) || event.target.closest(`#${ROOT_ID} .yto-gear`)) return;
      ui.panel.classList.remove('is-open');
    });
  }

  function setSubtitleText(text) {
    const ui = ensureUi();
    if (!ui) return;
    const value = sanitizeText(text);
    ui.subtitle.innerHTML = value ? escapeHtml(value) : '';
    ui.subtitle.classList.toggle('is-empty', !value);
  }

  function groupSegments(segments, size = DISPLAY_GROUP_SIZE) {
    const rows = [];
    for (let i = 0; i < segments.length; i += size) {
      const chunk = segments.slice(i, i + size).filter((x) => sanitizeText(x.text));
      if (!chunk.length) continue;
      const startMs = chunk[0].startMs;
      const endMs = Math.max(chunk[chunk.length - 1].endMs || 0, startMs + 1200);
      const text = sanitizeText(chunk.map((x) => x.text).join(' '));
      if (!text) continue;
      rows.push({
        startMs,
        endMs,
        text,
        translatedText: '',
        indexStart: i,
        indexEnd: i + chunk.length - 1
      });
    }
    return rows;
  }

  function fillSegmentEndTimes(rows) {
    return rows.map((row, idx) => {
      const next = rows[idx + 1];
      const fallbackEnd = row.startMs + 4000;
      const endMs = Math.max(
        row.endMs || 0,
        next ? Math.max(next.startMs, row.startMs + 800) : fallbackEnd
      );
      return {
        ...row,
        endMs
      };
    });
  }

  function formatSrtTimestamp(ms) {
    const total = Math.max(0, Math.floor(ms));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  function buildSrtFromSegments(segments) {
    return segments.map((segment, index) => {
      return [
        String(index + 1),
        `${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(segment.endMs)}`,
        sanitizeText(segment.text)
      ].join('\n');
    }).join('\n\n');
  }

  function stripCodeFences(text) {
    const body = String(text || '').trim();
    const match = body.match(/^```(?:srt|text)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : body;
  }

  function parseSrt(text) {
    const rows = [];
    const blocks = stripCodeFences(text).split(/\n\s*\n+/);

    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      let pointer = 0;
      if (/^\d+$/.test(lines[pointer])) pointer += 1;
      const timeLine = lines[pointer];
      if (!timeLine || !timeLine.includes('-->')) continue;
      pointer += 1;
      const body = sanitizeText(lines.slice(pointer).join(' '));
      rows.push({
        timeLine,
        text: body
      });
    }

    return rows;
  }

  function buildTranslationWindows(segments, size = TRANSLATION_WINDOW_SIZE) {
    const windows = [];
    for (let i = 0; i < segments.length; i += size) {
      const chunk = segments.slice(i, i + size);
      if (!chunk.length) continue;
      windows.push({
        windowIndex: windows.length,
        startIndex: i,
        endIndex: i + chunk.length - 1,
        status: 'pending',
        attempts: 0,
        message: ''
      });
    }
    return windows;
  }

  function getWindowForGroupedIndex(groupedIndex) {
    if (groupedIndex < 0) return null;
    return Math.floor(groupedIndex / TRANSLATION_WINDOW_SIZE);
  }

  function resetTranslationState() {
    state.translation = {
      requestKey: `${state.videoId || 'none'}:${state.transcriptRequestId}:${Date.now()}`,
      windows: [],
      queue: [],
      inFlight: null,
      completedCount: 0,
      totalCount: 0,
      errorCount: 0,
      priorityWindowIndex: null
    };
    for (const segment of state.groupedSegments) {
      segment.translatedText = '';
    }
  }

  function setTranslationStatus(text, isError = false) {
    setStatusParts({
      translationText: text,
      translationError: isError
    });
  }

  function updateTranslationStatus() {
    if (!state.settings.translationEnabled) {
      setTranslationStatus('', false);
      return;
    }

    if (state.currentTranscriptMeta?.shouldSkipTranslation) {
      setTranslationStatus(state.currentTranscriptMeta.skipReason, false);
      return;
    }

    if (!state.settings.translationApiKey) {
      setTranslationStatus('翻訳は有効です。Gemini API Key を入力すると翻訳を開始します。', false);
      return;
    }

    if (!state.groupedSegments.length) {
      setTranslationStatus('翻訳対象の字幕を待機しています。', false);
      return;
    }

    const { completedCount, totalCount, inFlight, errorCount, priorityWindowIndex } = state.translation;
    const latestError = state.translation.windows.find((windowMeta) => windowMeta.status === 'error' && windowMeta.message)?.message || '';
    const finishedCount = completedCount + errorCount;
    if (!totalCount) {
      setTranslationStatus('翻訳対象のブロックがまだ準備できていません。', false);
      return;
    }

    const progress = `翻訳中 ${finishedCount}/${totalCount} ウィンドウ`;
    if (inFlight != null && priorityWindowIndex === inFlight) {
      setTranslationStatus(`${progress}。現在位置の翻訳を優先しています。`, errorCount > 0);
      return;
    }
    if (finishedCount >= totalCount && errorCount === 0) {
      setTranslationStatus(`翻訳完了 ${completedCount}/${totalCount} ウィンドウ。`, false);
      return;
    }
    if (finishedCount >= totalCount && errorCount > 0) {
      setTranslationStatus(`翻訳完了 ${completedCount}/${totalCount} ウィンドウ。失敗 ${errorCount} 件。${latestError ? ` 最後のエラー: ${latestError}` : ''}`, true);
      return;
    }
    if (errorCount > 0) {
      setTranslationStatus(`${progress}。失敗 ${errorCount} 件。${latestError ? ` 最新エラー: ${latestError}` : ''}`, true);
      return;
    }
    setTranslationStatus(`${progress}。5ブロック単位で順番に翻訳しています。`, false);
  }

  function setupTranslationState() {
    resetTranslationState();

    if (!state.settings.translationEnabled) {
      updateTranslationStatus();
      return;
    }
    if (state.currentTranscriptMeta?.shouldSkipTranslation) {
      updateTranslationStatus();
      return;
    }
    if (!state.settings.translationApiKey) {
      updateTranslationStatus();
      return;
    }
    if (!state.groupedSegments.length) {
      updateTranslationStatus();
      return;
    }

    state.translation.windows = buildTranslationWindows(state.groupedSegments, TRANSLATION_WINDOW_SIZE);
    state.translation.queue = state.translation.windows.map((windowMeta) => windowMeta.windowIndex);
    state.translation.totalCount = state.translation.windows.length;
    updateTranslationStatus();
    processTranslationQueue();
  }

  function reprioritizeWindow(windowIndex) {
    if (!state.settings.translationEnabled) return;
    if (windowIndex == null || windowIndex < 0) return;
    const windowMeta = state.translation.windows[windowIndex];
    if (!windowMeta) return;
    if (windowMeta.status === 'done' || windowMeta.status === 'running') return;

    state.translation.queue = state.translation.queue.filter((value) => value !== windowIndex);
    state.translation.queue.unshift(windowIndex);
    state.translation.priorityWindowIndex = windowIndex;
    updateTranslationStatus();
    processTranslationQueue();
  }

  async function processTranslationQueue() {
    if (!state.settings.translationEnabled) return;
    if (!state.settings.translationApiKey) return;
    if (state.translation.inFlight != null) return;

    const nextWindowIndex = state.translation.queue.find((windowIndex) => {
      const windowMeta = state.translation.windows[windowIndex];
      return windowMeta && windowMeta.status === 'pending';
    });

    if (nextWindowIndex == null) {
      updateTranslationStatus();
      return;
    }

    const windowMeta = state.translation.windows[nextWindowIndex];
    if (!windowMeta) return;

    state.translation.queue = state.translation.queue.filter((value) => value !== nextWindowIndex);
    state.translation.inFlight = nextWindowIndex;
    state.translation.priorityWindowIndex = state.translation.priorityWindowIndex === nextWindowIndex ? nextWindowIndex : state.translation.priorityWindowIndex;
    windowMeta.status = 'running';
    windowMeta.attempts += 1;
    updateTranslationStatus();

    const chunk = state.groupedSegments.slice(windowMeta.startIndex, windowMeta.endIndex + 1);
    const payload = {
      type: 'translateWindow',
      requestKey: state.translation.requestKey,
      videoId: state.videoId,
      model: state.settings.translationModel,
      targetLanguage: 'Japanese',
      entryCount: chunk.length,
      srt: buildSrtFromSegments(chunk)
    };

    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (state.translation.requestKey !== payload.requestKey) return;
      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message);
      }
      if (!response?.ok) {
        throw new Error(response?.error || '翻訳 API の応答が不正でした。');
      }
      applyTranslatedWindow(windowMeta, chunk, response.entries);
    } catch (error) {
      if (state.translation.requestKey !== payload.requestKey) return;
      windowMeta.status = 'error';
      windowMeta.message = error?.message || '翻訳に失敗しました。';
      state.translation.errorCount += 1;
      log('translation failed', nextWindowIndex, error);
    } finally {
      if (state.translation.requestKey === payload.requestKey) {
        state.translation.inFlight = null;
        if (state.translation.priorityWindowIndex === nextWindowIndex) {
          state.translation.priorityWindowIndex = null;
        }
        updateTranslationStatus();
        syncSubtitle();
        processTranslationQueue();
      }
    }
  }

  function applyTranslatedWindow(windowMeta, originalChunk, translatedEntries) {
    if (!Array.isArray(translatedEntries)) {
      throw new Error('翻訳結果の JSON 配列を受け取れませんでした。');
    }
    if (translatedEntries.length !== originalChunk.length) {
      throw new Error(`翻訳 JSON の件数が一致しません。expected=${originalChunk.length}, actual=${translatedEntries.length}`);
    }

    const normalizedEntries = translatedEntries.map((entry) => ({
      index: Number(entry?.index),
      text: sanitizeText(entry?.text)
    }));

    const expectedIndexes = originalChunk.map((_segment, offset) => offset + 1);
    const actualIndexes = normalizedEntries.map((entry) => entry.index);
    const indexesMatch = expectedIndexes.every((expected, idx) => actualIndexes[idx] === expected);
    if (!indexesMatch) {
      throw new Error(`翻訳 JSON の index が一致しません。expected=${expectedIndexes.join(',')}, actual=${actualIndexes.join(',')}`);
    }

    const nonEmptyCount = normalizedEntries.filter((entry) => entry.text).length;
    if (nonEmptyCount < Math.ceil(originalChunk.length / 2)) {
      throw new Error('翻訳結果の空行が多すぎるため採用しません。');
    }

    for (let offset = 0; offset < originalChunk.length; offset += 1) {
      const grouped = state.groupedSegments[windowMeta.startIndex + offset];
      if (!grouped) continue;
      grouped.translatedText = normalizedEntries[offset].text;
    }

    windowMeta.status = 'done';
    windowMeta.message = '';
    state.translation.completedCount += 1;
  }

  function parseTranscriptPanelRows() {
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
    if (!panel) return [];
    const rows = Array.from(panel.querySelectorAll('ytd-transcript-segment-renderer'));
    if (!rows.length) return [];

    const parsed = rows.map((row) => {
      const timeEl = row.querySelector('.segment-timestamp, [class*="timestamp"]');
      const textEl = row.querySelector('yt-formatted-string.segment-text, .segment-text');
      const startMs = parseTimestampText(timeEl?.textContent || '');
      let text = sanitizeText(textEl?.textContent || '');

      if (!text) {
        const clone = row.cloneNode(true);
        clone.querySelectorAll('.segment-timestamp, [class*="timestamp"], button, tp-yt-paper-button').forEach((el) => el.remove());
        text = sanitizeText(clone.textContent || '');
      }

      return startMs == null || !text ? null : { startMs, endMs: 0, text };
    }).filter(Boolean);

    return fillSegmentEndTimes(parsed);
  }

  function panelHasRows() {
    return parseTranscriptPanelRows().length > 0;
  }

  async function waitForTranscriptRows(timeoutMs = 8000) {
    const startedAt = Date.now();
    let transcriptTabClicked = false;

    while (Date.now() - startedAt < timeoutMs) {
      if (panelHasRows()) return true;

      const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
      if (panel && !transcriptTabClicked) {
        const transcriptTab = findVisibleElement('button,[role="tab"],[role="button"]', (el) => {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim().toLowerCase();
          return label.includes('transcript') || label.includes('文字起こし');
        });
        if (transcriptTab) {
          transcriptTab.click();
          transcriptTabClicked = true;
        }
      }

      await sleep(250);
    }

    return panelHasRows();
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !el.hasAttribute('hidden') && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  }

  function findVisibleElement(selectors, predicate) {
    return Array.from(document.querySelectorAll(selectors))
      .filter((el) => !el.closest(`#${ROOT_ID}`))
      .find((el) => isElementVisible(el) && predicate(el));
  }

  async function clickVisible(el) {
    if (!el) return false;
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    await sleep(80);
    el.click();
    return true;
  }

  async function maybeOpenTranscriptPanel() {
    if (panelHasRows()) return true;

    const existingPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
    if (existingPanel && isElementVisible(existingPanel)) {
      if (await waitForTranscriptRows()) return true;
    }

    const transcriptTexts = ['show transcript', 'transcript', '文字起こしを表示', '文字起こし'];
    const isTranscriptText = (text) => {
      const normalized = String(text || '').trim().toLowerCase();
      return transcriptTexts.some((needle) => normalized.includes(needle));
    };

    const clickableSelectors = [
      'button',
      '[role="button"]',
      'ytd-menu-service-item-renderer',
      'tp-yt-paper-item',
      'yt-formatted-string'
    ];

    const directCandidate = findVisibleElement(clickableSelectors.join(','), (el) => {
      return isTranscriptText(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    });

    if (directCandidate) {
      await clickVisible(directCandidate);
      if (await waitForTranscriptRows()) return true;
    }

    const expandTexts = ['...more', 'show more', 'さらに表示'];
    const expandButton = findVisibleElement('button,[role="button"]', (el) => {
      const text = String(el.textContent || '').trim().toLowerCase();
      const aria = String(el.getAttribute('aria-label') || '').trim().toLowerCase();
      const title = String(el.getAttribute('title') || '').trim().toLowerCase();
      const joined = [text, aria, title].filter(Boolean).join(' ');
      if (joined.includes('more actions') || joined.includes('その他の操作')) return false;
      return expandTexts.some((needle) => text === needle || aria === needle || title === needle);
    });

    if (expandButton) {
      await clickVisible(expandButton);
      await sleep(500);
      const transcriptAfterExpand = findVisibleElement(clickableSelectors.join(','), (el) => {
        return isTranscriptText(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      });
      if (transcriptAfterExpand) {
        await clickVisible(transcriptAfterExpand);
        if (await waitForTranscriptRows()) return true;
      }
    }

    const moreTexts = ['more actions', 'その他の操作', '操作', 'その他'];
    const moreButton = findVisibleElement('button, [role="button"]', (el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.toLowerCase();
      return moreTexts.some((needle) => label.includes(needle));
    });

    if (moreButton) {
      await clickVisible(moreButton);
      await sleep(500);
      const menuItem = findVisibleElement('ytd-menu-service-item-renderer,tp-yt-paper-item,button,[role="menuitem"],[role="button"]', (el) => {
        return isTranscriptText(el.textContent || el.getAttribute('aria-label') || '');
      });
      if (menuItem) {
        await clickVisible(menuItem);
        if (await waitForTranscriptRows()) return true;
      }
    }

    return panelHasRows();
  }

  function parseJson3Transcript(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const rows = [];
    for (const event of events) {
      if (!Array.isArray(event?.segs)) continue;
      const text = sanitizeText(event.segs.map((seg) => seg?.utf8 || '').join(''));
      if (!text) continue;
      const startMs = Number(event.tStartMs || 0);
      const durationMs = Number(event.dDurationMs || 0);
      rows.push({
        startMs,
        endMs: startMs + Math.max(durationMs, 1000),
        text
      });
    }
    return fillSegmentEndTimes(rows);
  }

  function extractYoutubeiBootstrapFromHtml(html) {
    const source = String(html || '');
    const out = {
      apiKey: '',
      transcriptParams: '',
      clientName: 'WEB',
      clientVersion: '2.0'
    };

    const apiKeyMatch = source.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (apiKeyMatch?.[1]) out.apiKey = apiKeyMatch[1];

    const transcriptPatterns = [
      /getTranscriptEndpoint\s*:\s*{[^{}]*params\s*:\s*["']([^"']+)["']/,
      /["']?getTranscriptEndpoint["']?\s*:\s*{[^{}]*["']?params["']?\s*:\s*["']([^"']+)["']/,
      /getTranscriptEndpoint["']?\s*:\s*{[\s\S]*?params["']?\s*:\s*["']([^"']+)["']/,
      /getTranscriptEndpoint[^{]*{[^}]*params[^:]*:\s*["']([^"']+)["']/
    ];

    for (const pattern of transcriptPatterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        out.transcriptParams = match[1];
        break;
      }
    }

    if (!out.transcriptParams) {
      const endpointMatch = source.match(/getTranscriptEndpoint[^{]*({[\s\S]*?})(?=\s*[,}])/);
      const paramsMatch = endpointMatch?.[1]?.match(/params\s*:\s*["']([^"']+)["']/);
      if (paramsMatch?.[1]) {
        out.transcriptParams = paramsMatch[1];
      }
    }

    const nameMatch = source.match(/["']?clientName["']?\s*:\s*["']([^"']+)["']/);
    if (nameMatch?.[1]) out.clientName = nameMatch[1];

    const versionMatch = source.match(/["']?clientVersion["']?\s*:\s*["']([^"']+)["']/);
    if (versionMatch?.[1]) out.clientVersion = versionMatch[1];

    return out;
  }

  async function fetchMobilePlayerResponse(videoId, clientSpec) {
    const htmlResponse = await fetch(location.href, { credentials: 'include' });
    const html = await htmlResponse.text();
    const bootstrap = extractYoutubeiBootstrapFromHtml(html);
    if (!bootstrap.apiKey) {
      throw new Error('player endpoint 用の API key を取得できませんでした。');
    }

    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(bootstrap.apiKey)}`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: clientSpec.clientName,
            clientVersion: clientSpec.clientVersion,
            hl: clientSpec.hl || 'en',
            gl: clientSpec.gl || 'US',
            ...clientSpec.extraClient
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`${clientSpec.label} player endpoint が ${response.status} を返しました。`);
    }

    return response.json();
  }

  function parseYoutubeiTranscriptResponse(payload) {
    const rows = [];

    function pushSegment(item) {
      const renderer = item?.transcriptSegmentRenderer;
      if (!renderer) return;
      const runs = renderer?.snippet?.runs || renderer?.snippet?.cue?.runs || [];
      const text = sanitizeText(runs.map((run) => run?.text || '').join(''));
      if (!text) return;
      const startMs = Number(renderer.startMs || 0);
      const endMs = Number(renderer.endMs || 0);
      rows.push({
        startMs,
        endMs: Math.max(endMs, startMs + 1000),
        text
      });
    }

    const actions = Array.isArray(payload?.actions) ? payload.actions : [];
    for (const action of actions) {
      const initialSegments = action?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
      if (Array.isArray(initialSegments)) {
        initialSegments.forEach(pushSegment);
      }

      const continuationItems = action?.appendContinuationItemsAction?.continuationItems;
      if (Array.isArray(continuationItems)) {
        continuationItems.forEach(pushSegment);
      }
    }

    return fillSegmentEndTimes(rows);
  }

  async function fetchYoutubeiTranscript(videoId) {
    const htmlResponse = await fetch(location.href, { credentials: 'include' });
    const html = await htmlResponse.text();
    const bootstrap = extractYoutubeiBootstrapFromHtml(html);
    if (!bootstrap.transcriptParams) {
      throw new Error('Transcript endpoint の params を取得できませんでした。');
    }

    const response = await fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: bootstrap.clientName || 'WEB',
            clientVersion: bootstrap.clientVersion || '2.0'
          }
        },
        params: bootstrap.transcriptParams,
        videoId
      })
    });

    if (!response.ok) {
      throw new Error(`Transcript endpoint が ${response.status} を返しました。`);
    }

    const payload = await response.json();
    const segments = parseYoutubeiTranscriptResponse(payload);
    if (!segments.length) {
      throw new Error('Transcript endpoint の応答から字幕行を抽出できませんでした。');
    }

    return {
      segments,
      trackLabel: 'YouTube transcript endpoint',
      transcriptMeta: await inferTranscriptMeta()
    };
  }

  function getCaptionTracks(playerResponse) {
    return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function chooseCaptionTrack(playerResponse) {
    const tracks = getCaptionTracks(playerResponse);
    if (!tracks.length) return null;

    const preferred = [
      tracks.find((x) => !x.kind && !x.isTranslatable),
      tracks.find((x) => !x.kind),
      tracks.find((x) => x.kind === 'asr' && !x.isTranslatable),
      tracks.find((x) => x.kind === 'asr'),
      tracks[0]
    ].filter(Boolean);

    return preferred[0] || null;
  }

  async function inferTranscriptMeta() {
    try {
      const playerResponse = await requestPlayerResponseViaBridge();
      const track = chooseCaptionTrack(playerResponse);
      return buildTranscriptMeta('playerResponse', track);
    } catch {
      return buildTranscriptMeta('unknown');
    }
  }

  function buildCaptionUrls(baseUrl) {
    const out = [];
    const push = (value) => {
      if (value && !out.includes(value)) out.push(value);
    };

    try {
      const original = new URL(baseUrl, location.origin);
      push(original.toString());

      const json3 = new URL(original.toString());
      json3.searchParams.set('fmt', 'json3');
      push(json3.toString());

      const srv3 = new URL(original.toString());
      srv3.searchParams.set('fmt', 'srv3');
      push(srv3.toString());

      const vtt = new URL(original.toString());
      vtt.searchParams.set('fmt', 'vtt');
      push(vtt.toString());
    } catch {}

    return out;
  }

  function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(text || '');
    return textarea.value;
  }

  function parseXmlTranscript(text) {
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    const parseError = xml.querySelector('parsererror');
    if (parseError) return [];

    const rows = [];
    const nodes = Array.from(xml.querySelectorAll('text, p'));
    for (const node of nodes) {
      const startRaw = node.getAttribute('start') ?? node.getAttribute('t');
      const durRaw = node.getAttribute('dur') ?? node.getAttribute('d');
      if (startRaw == null) continue;

      let startMs = Number(startRaw);
      let durationMs = durRaw == null ? 0 : Number(durRaw);
      if (!Number.isFinite(startMs)) continue;

      const looksLikeSeconds = String(startRaw).includes('.') || startMs < 1000;
      if (looksLikeSeconds) startMs *= 1000;
      if (durRaw != null) {
        const durLooksLikeSeconds = String(durRaw).includes('.') || durationMs < 1000;
        if (durLooksLikeSeconds) durationMs *= 1000;
      }

      let body = '';
      const segs = Array.from(node.querySelectorAll('s'));
      if (segs.length) {
        body = segs.map((seg) => seg.textContent || '').join('');
      } else {
        body = node.textContent || '';
      }

      const clean = sanitizeText(decodeHtmlEntities(body));
      if (!clean) continue;
      rows.push({
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(0, Math.round(startMs + Math.max(durationMs, 1000))),
        text: clean
      });
    }

    return fillSegmentEndTimes(rows);
  }

  function parseVttTranscript(text) {
    const blocks = String(text || '').split(/\r?\n\r?\n+/);
    const rows = [];

    function toMs(part) {
      const m = String(part || '').trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
      if (!m) return null;
      const h = Number(m[1] || 0);
      const min = Number(m[2] || 0);
      const sec = Number(m[3] || 0);
      const ms = Number(String(m[4] || '0').padEnd(3, '0').slice(0, 3));
      return (((h * 60) + min) * 60 + sec) * 1000 + ms;
    }

    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length) continue;
      const timeLine = lines.find((line) => line.includes('-->'));
      if (!timeLine) continue;
      const [a, b] = timeLine.split('-->').map((x) => x.trim());
      const startMs = toMs(a);
      const endMs = toMs(b);
      if (startMs == null) continue;
      const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ');
      const clean = sanitizeText(body.replace(/<[^>]+>/g, ' '));
      if (!clean) continue;
      rows.push({
        startMs,
        endMs: endMs != null ? Math.max(endMs, startMs + 1000) : startMs + 2000,
        text: clean
      });
    }

    return fillSegmentEndTimes(rows);
  }

  function parseTranscriptResponse(text) {
    const body = String(text || '').trim();
    if (!body) return [];

    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        return parseJson3Transcript(JSON.parse(body));
      } catch {
        return [];
      }
    }

    if (/^WEBVTT/i.test(body)) {
      return parseVttTranscript(body);
    }

    if (body.startsWith('<')) {
      return parseXmlTranscript(body);
    }

    return [];
  }

  async function fetchCaptionTrack(track) {
    const urls = buildCaptionUrls(track.baseUrl || '');
    const failures = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        if (!response.ok) {
          failures.push(`status=${response.status}`);
          continue;
        }
        if (!text.trim()) {
          failures.push('empty');
          continue;
        }
        const segments = parseTranscriptResponse(text);
        if (segments.length) {
          return segments;
        }
        failures.push('unparsed');
      } catch (error) {
        failures.push(error?.message || 'fetch failed');
      }
    }

    throw new Error(`字幕レスポンスを解釈できませんでした。${failures.join(', ')}`);
  }

  async function requestPlayerResponseViaBridge(timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener(RESPONSE_EVENT, onResponse);
        resolve(null);
      }, timeoutMs);

      function onResponse(event) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener(RESPONSE_EVENT, onResponse);
        resolve(event.detail?.playerResponse || null);
      }

      window.addEventListener(RESPONSE_EVENT, onResponse);
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
    });
  }

  async function fetchJson3Fallback(videoId) {
    const playerResponse = await requestPlayerResponseViaBridge();
    const reasons = [];

    const sources = [];
    if (playerResponse) {
      sources.push({
        label: 'WEB',
        playerResponse
      });
    }

    const mobileClients = [
      {
        label: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        extraClient: {
          androidSdkVersion: 30
        }
      },
      {
        label: 'IOS',
        clientName: 'IOS',
        clientVersion: '20.10.4',
        extraClient: {
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.3.2'
        }
      }
    ];

    for (const clientSpec of mobileClients) {
      try {
        const mobileResponse = await fetchMobilePlayerResponse(videoId, clientSpec);
        sources.push({
          label: clientSpec.label,
          playerResponse: mobileResponse
        });
      } catch (error) {
        reasons.push(`${clientSpec.label}: ${error?.message || 'player fetch failed'}`);
      }
    }

    for (const source of sources) {
      const tracks = getCaptionTracks(source.playerResponse);
      if (!tracks.length) {
        reasons.push(`${source.label}: 字幕トラックが見つかりませんでした。`);
        continue;
      }

      const orderedTracks = [];
      const primary = chooseCaptionTrack(source.playerResponse);
      if (primary) orderedTracks.push(primary);
      for (const track of tracks) {
        if (!orderedTracks.includes(track)) orderedTracks.push(track);
      }

      for (const track of orderedTracks) {
        try {
          const segments = await fetchCaptionTrack(track);
          if (segments.length) {
            const transcriptMeta = buildTranscriptMeta(source.label, track);
            return {
              segments,
              trackLabel: transcriptMeta.label || `${source.label} ${track.languageCode || videoId || ''}`.trim(),
              transcriptMeta
            };
          }
        } catch (error) {
          reasons.push(`${source.label} ${textFromName(track.name) || track.languageCode || 'unknown'}: ${error?.message || 'failed'}`);
        }
      }
    }

    throw new Error(`字幕取得に失敗しました。${reasons.join(' | ')}`);
  }

  async function loadTranscriptForCurrentVideo(videoId) {
    if (!videoId) throw new Error('動画IDを取得できませんでした。');

    const reasons = [];

    try {
      const opened = await maybeOpenTranscriptPanel();
      if (opened) {
        const panelRows = parseTranscriptPanelRows();
        if (panelRows.length) {
          return {
            segments: panelRows,
            trackLabel: 'Transcript panel',
            transcriptMeta: await inferTranscriptMeta()
          };
        }
        reasons.push('Transcript panel は開いたが行を取得できませんでした。');
      } else {
        reasons.push('Transcript panel を開けませんでした。');
      }
    } catch (error) {
      reasons.push(error?.message || 'Transcript panel の取得に失敗しました。');
    }

    try {
      return await fetchYoutubeiTranscript(videoId);
    } catch (error) {
      reasons.push(error?.message || 'Transcript endpoint の取得に失敗しました。');
    }

    try {
      return await fetchJson3Fallback(videoId);
    } catch (error) {
      reasons.push(error?.message || 'captionTracks の取得に失敗しました。');
    }

    throw new Error(`字幕取得に失敗しました。${reasons.join(' | ')}`);
  }

  function findActiveIndex(currentMs) {
    const rows = state.groupedSegments;
    if (!rows.length) return -1;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const next = rows[i + 1];
      if (currentMs >= row.startMs && currentMs < row.endMs) return i;
      if (next && currentMs >= row.startMs && currentMs < next.startMs) return i;
    }
    return currentMs < rows[0].startMs ? -1 : rows.length - 1;
  }

  function getDisplayText(groupedSegment) {
    if (!groupedSegment) return '';
    if (state.currentTranscriptMeta?.shouldHideOverlay) {
      return '';
    }
    if (state.settings.translationEnabled && sanitizeText(groupedSegment.translatedText)) {
      return groupedSegment.translatedText;
    }
    return groupedSegment.text;
  }

  function maybePrioritizeActiveWindow(groupedIndex) {
    if (groupedIndex < 0) return;
    const windowIndex = getWindowForGroupedIndex(groupedIndex);
    const windowMeta = state.translation.windows[windowIndex];
    if (!windowMeta) return;
    if (windowMeta.status === 'pending') {
      reprioritizeWindow(windowIndex);
    }
  }

  function syncSubtitle() {
    const ui = ensureUi();
    if (!ui) return;
    const video = getVideoEl();
    if (!video) return;
    const currentMs = Math.floor(video.currentTime * 1000);
    const nextIndex = findActiveIndex(currentMs);
    const text = nextIndex >= 0 ? getDisplayText(state.groupedSegments[nextIndex]) : '';
    if (nextIndex === state.activeIndex && text === state.activeText) return;
    state.activeIndex = nextIndex;
    state.activeText = text;
    if (nextIndex >= 0) maybePrioritizeActiveWindow(nextIndex);
    setSubtitleText(text);
  }

  async function refreshTranscript(force = false) {
    const videoId = getVideoIdFromUrl(location.href);
    if (!isWatchLikeUrl(location.href) || !videoId) {
      state.videoId = null;
      state.rawSegments = [];
      state.groupedSegments = [];
      state.activeIndex = -1;
      state.activeText = '';
      state.currentTrackLabel = '';
      state.currentTranscriptMeta = null;
      resetTranslationState();
      setSubtitleText('');
      setStatusParts({
        transcriptText: 'YouTube の動画ページを開いてください。',
        transcriptError: false,
        translationText: '',
        translationError: false
      });
      return;
    }

    if (!force && state.videoId === videoId && state.groupedSegments.length) return;

    const requestId = ++state.transcriptRequestId;
    state.videoId = videoId;
    state.activeIndex = -1;
    state.activeText = '';
    setSubtitleText('');
    setStatusParts({
      transcriptText: '字幕を読み込んでいます…',
      transcriptError: false,
      translationText: '',
      translationError: false
    });

    try {
      const { segments, trackLabel, transcriptMeta } = await loadTranscriptForCurrentVideo(videoId);
      if (requestId !== state.transcriptRequestId) return;
      state.rawSegments = segments;
      state.groupedSegments = groupSegments(segments, DISPLAY_GROUP_SIZE);
      state.currentTrackLabel = trackLabel;
      state.currentTranscriptMeta = transcriptMeta || buildTranscriptMeta(trackLabel || 'unknown');
      if (!state.groupedSegments.length) {
        throw new Error('連結後の字幕が空でした。');
      }
      const transcriptSummary = `字幕を読み込みました。${state.rawSegments.length} 行を ${state.groupedSegments.length} ブロックに連結しました。`;
      setStatusParts({
        transcriptText: state.currentTranscriptMeta?.shouldHideOverlay
          ? `${transcriptSummary} ${state.currentTranscriptMeta.skipReason}`
          : transcriptSummary,
        transcriptError: false
      });
      setupTranslationState();
      syncSubtitle();
    } catch (error) {
      if (requestId !== state.transcriptRequestId) return;
      state.rawSegments = [];
      state.groupedSegments = [];
      state.activeIndex = -1;
      state.activeText = '';
      state.currentTrackLabel = '';
      state.currentTranscriptMeta = null;
      resetTranslationState();
      setSubtitleText('');
      setStatusParts({
        transcriptText: error?.message || '字幕の読み込みに失敗しました。',
        transcriptError: true,
        translationText: '',
        translationError: false
      });
      log(error);
    }
  }

  function installNavigationHooks() {
    window.addEventListener(NAV_EVENT, async () => {
      await sleep(250);
      if (location.href === state.url) return;
      state.url = location.href;
      ensureUi();
      await refreshTranscript(true);
    });

    clearInterval(state.navTimer);
    state.navTimer = window.setInterval(async () => {
      if (location.href === state.url) {
        ensureUi();
        return;
      }
      state.url = location.href;
      ensureUi();
      await refreshTranscript(true);
    }, 1000);
  }

  function installSyncTimer() {
    clearInterval(state.syncTimer);
    state.syncTimer = window.setInterval(() => {
      ensureUi();
      syncSubtitle();
    }, 120);
  }

  async function boot() {
    if (state.booted) return;
    state.booted = true;
    injectBridge();
    await loadSettings();
    ensureUi();
    installNavigationHooks();
    installSyncTimer();
    await refreshTranscript(true);
  }

  boot().catch((error) => {
    console.error('[YT Transcript Overlay] boot failed', error);
  });
})();
