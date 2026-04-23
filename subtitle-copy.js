(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.YtTranscriptCopy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const SUMMARY_PROMPT_PREFIX =
    'この動画の書き起こしを4000字以上8000字以内で要約してください。タイトル、目次、要約本文の構成でお願いします。以下、書き起こし：';
  const BRACKET_ONLY_CUE_PATTERN = /^(?:\[[^\]]+\]\s*)+$/;
  const INLINE_CUE_PATTERN = /\[(music|applause|laughter)\]/gi;
  const SPEAKER_PREFIX_PATTERN = /(^|\s)>>\s*/g;

  function sanitizeTranscriptText(text) {
    return String(text || '')
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !BRACKET_ONLY_CUE_PATTERN.test(line))
      .map((line) => line.replace(SPEAKER_PREFIX_PATTERN, '').trim())
      .map((line) => line.replace(INLINE_CUE_PATTERN, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildPlainTranscriptText(segments) {
    if (!Array.isArray(segments)) return '';

    const transcript = segments
      .map((segment) => sanitizeTranscriptText(segment?.text))
      .filter(Boolean)
      .join(' ');

    if (!transcript) return '';

    return `${SUMMARY_PROMPT_PREFIX} ${transcript}`;
  }

  return {
    buildPlainTranscriptText,
    sanitizeTranscriptText,
    SUMMARY_PROMPT_PREFIX
  };
});
