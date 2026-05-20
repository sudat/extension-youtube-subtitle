const test = require('node:test');
const assert = require('node:assert/strict');

global.chrome = {
  runtime: {
    onMessage: {
      addListener() {}
    }
  }
};

const { buildPrompt, callGemini, callZAi } = require('../background.js');

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

test('callGemini retries when translation indexes do not match the requested entries', async () => {
  const originalFetch = global.fetch;
  const responses = [
    [{ index: 1, text: 'ひとつめ' }, { index: 0, text: 'ふたつめ' }, { index: 0, text: 'みっつめ' }],
    [{ index: 1, text: 'ひとつめ' }, { index: 2, text: 'ふたつめ' }, { index: 3, text: 'みっつめ' }]
  ];
  let fetchCount = 0;

  global.fetch = async () => {
    const entries = responses[fetchCount];
    fetchCount += 1;
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(entries) }]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const entries = await callGemini({
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: 'Japanese',
      srt: [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        'one',
        '',
        '2',
        '00:00:02,000 --> 00:00:03,000',
        'two',
        '',
        '3',
        '00:00:03,000 --> 00:00:04,000',
        'three'
      ].join('\n'),
      entryCount: 3,
      context: {}
    });

    assert.equal(fetchCount, 2);
    assert.deepEqual(entries.map((entry) => entry.index), [1, 2, 3]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callZAi retries when translation indexes do not match the requested entries', async () => {
  const originalFetch = global.fetch;
  const responses = [
    [{ index: 1, text: 'ひとつめ' }, { index: 0, text: 'ふたつめ' }, { index: 0, text: 'みっつめ' }],
    [{ index: 1, text: 'ひとつめ' }, { index: 2, text: 'ふたつめ' }, { index: 3, text: 'みっつめ' }]
  ];
  let fetchCount = 0;

  global.fetch = async () => {
    const entries = responses[fetchCount];
    fetchCount += 1;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify(entries)
              }
            }
          ]
        };
      }
    };
  };

  try {
    const entries = await callZAi({
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: 'Japanese',
      srt: [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        'one',
        '',
        '2',
        '00:00:02,000 --> 00:00:03,000',
        'two',
        '',
        '3',
        '00:00:03,000 --> 00:00:04,000',
        'three'
      ].join('\n'),
      entryCount: 3,
      context: {}
    });

    assert.equal(fetchCount, 2);
    assert.deepEqual(entries.map((entry) => entry.index), [1, 2, 3]);
  } finally {
    global.fetch = originalFetch;
  }
});
