const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTranscriptLoadPlan,
  buildSubtitleBoxStyle,
  findActiveGroupedIndex,
  groupTranscriptSegments,
  resolveSubtitleOverlayUiState,
  normalizeDisplayGroupSize,
  parseXmlTiming
} = require('../transcript-sync.js');

test('buildTranscriptLoadPlan uses only API-based transcript sources', () => {
  assert.deepEqual(buildTranscriptLoadPlan(), ['youtubei', 'json3']);
});

test('findActiveGroupedIndex returns matching subtitle while within a row range', () => {
  const rows = [
    { startMs: 1000, endMs: 4000 },
    { startMs: 4000, endMs: 7000 }
  ];

  assert.equal(findActiveGroupedIndex(rows, 4500), 1);
});

test('findActiveGroupedIndex clears subtitle after the final row ends', () => {
  const rows = [
    { startMs: 1000, endMs: 4000 },
    { startMs: 4000, endMs: 7000 }
  ];

  assert.equal(findActiveGroupedIndex(rows, 7100), -1);
});


test('findActiveGroupedIndex returns the next subtitle during a short explicit gap', () => {
  const rows = [
    { startMs: 50000, endMs: 55000, hasExplicitEndMs: true },
    { startMs: 57000, endMs: 61000, hasExplicitEndMs: true }
  ];

  assert.equal(findActiveGroupedIndex(rows, 56000), 1);
});

test('findActiveGroupedIndex clears the overlay during a long explicit gap', () => {
  const rows = [
    { startMs: 50000, endMs: 55000, hasExplicitEndMs: true },
    { startMs: 61000, endMs: 65000, hasExplicitEndMs: true }
  ];

  assert.equal(findActiveGroupedIndex(rows, 58000), -1);
});

test('findActiveGroupedIndex keeps the previous subtitle when the prior end is inferred', () => {
  const rows = [
    { startMs: 50000, endMs: 61000 },
    { startMs: 61000, endMs: 65000, hasExplicitEndMs: true }
  ];

  assert.equal(findActiveGroupedIndex(rows, 58000), 0);
});

test('finalizeTranscriptSegments preserves explicit ends and only infers missing ones', () => {
  const { finalizeTranscriptSegments } = require('../transcript-sync.js');

  const finalized = finalizeTranscriptSegments([
    { startMs: 1000, endMs: 2500, hasExplicitEndMs: true, text: 'one' },
    { startMs: 5000, endMs: 0, text: 'two' },
    { startMs: 9000, endMs: 0, text: 'three' }
  ]);

  assert.deepEqual(finalized, [
    { startMs: 1000, endMs: 2500, hasExplicitEndMs: true, text: 'one' },
    { startMs: 5000, endMs: 9000, text: 'two' },
    { startMs: 9000, endMs: 13000, text: 'three' }
  ]);
});

test('parseXmlTiming keeps timedtext t/d attributes in milliseconds', () => {
  assert.deepEqual(
    parseXmlTiming({
      startAttrName: 't',
      startRaw: '90000',
      durAttrName: 'd',
      durRaw: '975'
    }),
    { startMs: 90000, durationMs: 975 }
  );
});

test('parseXmlTiming converts start/dur attributes from seconds to milliseconds', () => {
  assert.deepEqual(
    parseXmlTiming({
      startAttrName: 'start',
      startRaw: '90.5',
      durAttrName: 'dur',
      durRaw: '0.975'
    }),
    { startMs: 90500, durationMs: 975 }
  );
});

test('buildSubtitleBoxStyle fixes wrapping width independently from drag position', () => {
  assert.deepEqual(
    buildSubtitleBoxStyle({ playerWidth: 1280, maxWidthPct: 85 }),
    {
      width: 'max-content',
      maxWidth: '1088px'
    }
  );
});

test('buildSubtitleBoxStyle clamps invalid values to the player width bounds', () => {
  assert.deepEqual(
    buildSubtitleBoxStyle({ playerWidth: 800, maxWidthPct: 140 }),
    {
      width: 'max-content',
      maxWidth: '800px'
    }
  );
});

test('resolveSubtitleOverlayUiState keeps subtitle text and hide action while subtitles are visible', () => {
  assert.deepEqual(
    resolveSubtitleOverlayUiState({
      subtitleVisible: true,
      subtitleText: ' Hello   world '
    }),
    {
      renderedSubtitleText: 'Hello world',
      toggleMode: 'visible',
      toggleLabel: '字幕を非表示'
    }
  );
});

test('resolveSubtitleOverlayUiState clears subtitle text and flips the toggle label when subtitles are hidden', () => {
  assert.deepEqual(
    resolveSubtitleOverlayUiState({
      subtitleVisible: false,
      subtitleText: '字幕テキスト'
    }),
    {
      renderedSubtitleText: '',
      toggleMode: 'hidden',
      toggleLabel: '字幕を表示'
    }
  );
});

test('normalizeDisplayGroupSize falls back to the default when the input is invalid', () => {
  assert.equal(normalizeDisplayGroupSize(undefined), 5);
  assert.equal(normalizeDisplayGroupSize('abc'), 5);
  assert.equal(normalizeDisplayGroupSize(0), 5);
});

test('normalizeDisplayGroupSize clamps configured group sizes into the supported range', () => {
  assert.equal(normalizeDisplayGroupSize(3), 3);
  assert.equal(normalizeDisplayGroupSize(6), 5);
  assert.equal(normalizeDisplayGroupSize(99), 5);
});

test('groupTranscriptSegments groups subtitle rows by the configured size', () => {
  const grouped = groupTranscriptSegments(
    [
      { startMs: 1000, endMs: 2200, text: ' one ' },
      { startMs: 2200, endMs: 3400, text: 'two' },
      { startMs: 3400, endMs: 4600, text: 'three' },
      { startMs: 4600, endMs: 5800, text: ' four ' }
    ],
    3
  );

  assert.deepEqual(grouped, [
    {
      startMs: 1000,
      endMs: 4600,
      text: 'one two three',
      translatedText: '',
      indexStart: 0,
      indexEnd: 2
    },
    {
      startMs: 4600,
      endMs: 5800,
      text: 'four',
      translatedText: '',
      indexStart: 3,
      indexEnd: 3
    }
  ]);
});


test('groupTranscriptSegments preserves explicit end metadata from the last segment in a group', () => {
  const grouped = groupTranscriptSegments(
    [
      { startMs: 1000, endMs: 2000, hasExplicitEndMs: true, text: 'one' },
      { startMs: 2000, endMs: 2600, hasExplicitEndMs: true, text: 'two' }
    ],
    2
  );

  assert.deepEqual(grouped, [
    {
      startMs: 1000,
      endMs: 2600,
      hasExplicitEndMs: true,
      text: 'one two',
      translatedText: '',
      indexStart: 0,
      indexEnd: 1
    }
  ]);
});
