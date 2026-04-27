const test = require('node:test');
const assert = require('node:assert/strict');

global.chrome = {
  runtime: {
    onMessage: {
      addListener() {}
    }
  }
};

const { buildPrompt } = require('../background.js');

test('buildPrompt includes surrounding context without changing the target SRT entries', () => {
  const prompt = buildPrompt('Japanese', [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'I\'m',
    '',
    '2',
    '00:00:02,000 --> 00:00:03,000',
    'Arisa.'
  ].join('\n'), {
    previousOriginalSrt: [
      '1',
      '00:00:00,000 --> 00:00:01,000',
      'Hello.'
    ].join('\n'),
    nextOriginalSrt: [
      '1',
      '00:00:03,000 --> 00:00:04,000',
      'Nice to meet you.'
    ].join('\n'),
    previousTranslatedText: 'こんにちは。'
  });

  assert.match(prompt, /Translate the TARGET SRT subtitles into Japanese/);
  assert.match(prompt, /Previous original context/);
  assert.match(prompt, /Hello\./);
  assert.match(prompt, /Next original context/);
  assert.match(prompt, /Nice to meet you\./);
  assert.match(prompt, /Previous Japanese translation context/);
  assert.match(prompt, /こんにちは。/);
  assert.match(prompt, /TARGET SRT/);
  assert.match(prompt, /I'm/);
  assert.match(prompt, /Arisa\./);
  assert.match(prompt, /Return translations only for TARGET SRT entries/);
});

test('buildPrompt tells translators to omit disposable filler words but keep meaningful hesitation', () => {
  const prompt = buildPrompt('Japanese', [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'Um, um, I think this works.'
  ].join('\n'));

  assert.match(prompt, /Omit disposable filler words/);
  assert.match(prompt, /um, uh, er/);
  assert.match(prompt, /ええと/);
  assert.match(prompt, /Keep hesitation words when they carry meaning/);
});
