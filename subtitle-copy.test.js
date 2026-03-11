const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlainTranscriptText, SUMMARY_PROMPT_PREFIX } = require('./subtitle-copy.js');

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
