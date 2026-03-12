const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTranscriptLoadPlan,
  buildSubtitleBoxStyle,
  findActiveGroupedIndex,
  parseXmlTiming
} = require('../transcript-sync.js');

test('buildTranscriptLoadPlan prefers API sources before transcript panel', () => {
  assert.deepEqual(buildTranscriptLoadPlan(), ['youtubei', 'json3', 'panel']);
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
    buildSubtitleBoxStyle({ playerWidth: 1280, maxWidthPct: 78 }),
    {
      width: 'max-content',
      maxWidth: '998.4px'
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
