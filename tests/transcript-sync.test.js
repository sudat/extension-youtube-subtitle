const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTranscriptLoadPlan,
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
