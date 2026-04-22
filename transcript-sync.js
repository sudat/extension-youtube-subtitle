(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.YtTranscriptSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_DISPLAY_GROUP_SIZE = 5;
  const MIN_DISPLAY_GROUP_SIZE = 1;
  const MAX_DISPLAY_GROUP_SIZE = 5;
  const DEFAULT_DISPLAY_OFFSET_MS = 0;
  const MIN_DISPLAY_OFFSET_MS = -3000;
  const MAX_DISPLAY_OFFSET_MS = 3000;
  const LONG_GAP_THRESHOLD_MS = 5000;

  function buildTranscriptLoadPlan() {
    return ['youtubei', 'json3'];
  }

  function hasExplicitEnd(segment) {
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    return Boolean(
      segment?.hasExplicitEndMs === true &&
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      endMs > startMs
    );
  }

  function normalizeGapThreshold(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return LONG_GAP_THRESHOLD_MS;
    }

    return Math.round(numericValue);
  }

  function finalizeTranscriptSegments(segments) {
    const safeSegments = Array.isArray(segments) ? segments : [];

    return safeSegments.map((segment, index) => {
      const startMs = Math.max(0, Math.round(Number(segment?.startMs) || 0));
      const next = safeSegments[index + 1];
      const fallbackEndMs = startMs + 4000;
      const explicitEndMs = Math.max(0, Math.round(Number(segment?.endMs) || 0));
      const nextStartMs = Math.max(0, Math.round(Number(next?.startMs) || 0));
      const explicit = hasExplicitEnd({ ...segment, startMs, endMs: explicitEndMs });
      const endMs = explicit
        ? explicitEndMs
        : Math.max(
            explicitEndMs,
            next
              ? Math.max(nextStartMs, startMs + 800)
              : fallbackEndMs
          );

      return {
        ...segment,
        startMs,
        endMs,
        ...(explicit ? { hasExplicitEndMs: true } : {})
      };
    });
  }

  function findActiveGroupedIndex(rows, currentMs, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (!safeRows.length) return -1;
    const longGapThresholdMs = normalizeGapThreshold(options.longGapThresholdMs);

    for (let i = 0; i < safeRows.length; i += 1) {
      const row = safeRows[i];
      const next = safeRows[i + 1];
      const startMs = Number(row?.startMs) || 0;
      const endMs = Number(row?.endMs) || startMs;

      if (currentMs >= startMs && currentMs < endMs) return i;
      if (!next || currentMs < endMs) continue;

      const nextStartMs = Number(next?.startMs) || 0;
      if (currentMs >= endMs && currentMs < nextStartMs) {
        if (!row?.hasExplicitEndMs) return i;
        const gapMs = nextStartMs - endMs;
        return gapMs >= longGapThresholdMs ? -1 : i + 1;
      }
    }

    return -1;
  }

  function parseXmlTiming({ startAttrName, startRaw, durAttrName, durRaw }) {
    const startValue = Number(startRaw);
    const durationValue = durRaw == null ? 0 : Number(durRaw);

    if (!Number.isFinite(startValue)) {
      return { startMs: null, durationMs: 0 };
    }

    const startMs = startAttrName === 'start' ? startValue * 1000 : startValue;
    const durationMs =
      durRaw == null
        ? 0
        : durAttrName === 'dur'
          ? durationValue * 1000
          : durationValue;

    return {
      startMs: Math.max(0, Math.round(startMs)),
      durationMs: Math.max(0, Math.round(durationMs))
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeDisplayOffsetMs(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return DEFAULT_DISPLAY_OFFSET_MS;
    }

    return clamp(Math.round(numericValue), MIN_DISPLAY_OFFSET_MS, MAX_DISPLAY_OFFSET_MS);
  }

  function normalizeDisplayGroupSize(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < MIN_DISPLAY_GROUP_SIZE) {
      return DEFAULT_DISPLAY_GROUP_SIZE;
    }

    return clamp(Math.round(numericValue), MIN_DISPLAY_GROUP_SIZE, MAX_DISPLAY_GROUP_SIZE);
  }

  function sanitizeTranscriptText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function groupTranscriptSegments(segments, size = DEFAULT_DISPLAY_GROUP_SIZE) {
    const safeSegments = Array.isArray(segments) ? segments : [];
    const groupSize = normalizeDisplayGroupSize(size);
    const rows = [];

    for (let i = 0; i < safeSegments.length; i += groupSize) {
      const chunk = safeSegments.slice(i, i + groupSize).filter((segment) => sanitizeTranscriptText(segment?.text));
      if (!chunk.length) continue;

      const startMs = Number(chunk[0]?.startMs) || 0;
      const lastSegment = chunk[chunk.length - 1];
      const endMs = Math.max(Number(lastSegment?.endMs) || 0, startMs + 1200);
      const text = sanitizeTranscriptText(chunk.map((segment) => segment?.text || '').join(' '));
      if (!text) continue;

      rows.push({
        startMs,
        endMs,
        ...(lastSegment?.hasExplicitEndMs ? { hasExplicitEndMs: true } : {}),
        text,
        translatedText: '',
        indexStart: i,
        indexEnd: i + chunk.length - 1
      });
    }

    return rows;
  }

  function buildSubtitleBoxStyle({ playerWidth, maxWidthPct }) {
    const safePlayerWidth = Number(playerWidth);
    const safeWidth = Number.isFinite(safePlayerWidth) ? Math.max(0, safePlayerWidth) : 0;
    const safePct = clamp(Number(maxWidthPct) || 0, 0, 100);
    const resolvedMaxWidth = safeWidth ? `${(safeWidth * safePct) / 100}px` : `${safePct}%`;

    return {
      width: 'max-content',
      maxWidth: resolvedMaxWidth
    };
  }

  function resolveSubtitleOverlayUiState({ subtitleVisible = true, subtitleText = '' } = {}) {
    return {
      renderedSubtitleText: subtitleVisible ? sanitizeTranscriptText(subtitleText) : '',
      toggleMode: subtitleVisible ? 'visible' : 'hidden',
      toggleLabel: subtitleVisible ? '字幕を非表示' : '字幕を表示'
    };
  }

  return {
    buildTranscriptLoadPlan,
    buildSubtitleBoxStyle,
    finalizeTranscriptSegments,
    findActiveGroupedIndex,
    groupTranscriptSegments,
    normalizeDisplayGroupSize,
    normalizeDisplayOffsetMs,
    parseXmlTiming,
    resolveSubtitleOverlayUiState
  };
});
