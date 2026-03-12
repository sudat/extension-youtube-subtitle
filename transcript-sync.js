(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.YtTranscriptSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
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
    parseXmlTiming
  };
});
