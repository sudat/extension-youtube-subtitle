const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlainTranscriptText, SUMMARY_PROMPT_PREFIX } = require('../subtitle-copy.js');

test('buildPlainTranscriptText joins transcript blocks into one sentence', () => {
  const text = buildPlainTranscriptText([
    { text: ' Hello   world ' },
    { text: '\nthis is\t a test ' },
    { text: 'final block' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} Hello world this is a test final block`);
});

test('buildPlainTranscriptText skips empty transcript blocks', () => {
  const text = buildPlainTranscriptText([
    { text: 'first' },
    { text: '' },
    { text: '   ' },
    {},
    { text: 'second' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} first second`);
});

test('buildPlainTranscriptText returns empty when transcript is empty', () => {
  const text = buildPlainTranscriptText([{ text: ' ' }, {}, { text: '' }]);

  assert.equal(text, '');
});

test('buildPlainTranscriptText drops bracket-only cues', () => {
  const text = buildPlainTranscriptText([
    { text: '[music]' },
    { text: ' hello ' },
    { text: '[applause] [laughter]' },
    { text: 'world' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} hello world`);
});

test('buildPlainTranscriptText keeps inline bracket text that belongs to dialogue', () => {
  const text = buildPlainTranscriptText([
    { text: 'I said [really] no' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} I said [really] no`);
});

test('buildPlainTranscriptText strips speaker prefixes and drops prefix-only cues', () => {
  const text = buildPlainTranscriptText([
    { text: '>>' },
    { text: '>> hello there' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} hello there`);
});

test('buildPlainTranscriptText removes inline music cues while keeping dialogue', () => {
  const text = buildPlainTranscriptText([
    { text: 'every time with its skill. [music]' },
    { text: '>> [music]' },
    { text: '>> to recommend next steps' }
  ]);

  assert.equal(text, `${SUMMARY_PROMPT_PREFIX} every time with its skill. to recommend next steps`);
});
