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

  function buildTranscriptLoadPlan() {
    return ['youtubei', 'json3', 'panel'];
  }

  function findActiveGroupedIndex(rows, currentMs) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (!safeRows.length) return -1;

    for (let i = 0; i < safeRows.length; i += 1) {
      const row = safeRows[i];
      const next = safeRows[i + 1];
      if (currentMs >= row.startMs && currentMs < row.endMs) return i;
      if (next && currentMs >= row.startMs && currentMs < next.startMs) return i;
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
      const endMs = Math.max(Number(chunk[chunk.length - 1]?.endMs) || 0, startMs + 1200);
      const text = sanitizeTranscriptText(chunk.map((segment) => segment?.text || '').join(' '));
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

  return {
    buildTranscriptLoadPlan,
    buildSubtitleBoxStyle,
    findActiveGroupedIndex,
    groupTranscriptSegments,
    normalizeDisplayGroupSize,
    parseXmlTiming
  };
});
