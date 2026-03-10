const STORAGE_DEFAULTS = {
  translationEnabled: false,
  translationApiKey: '',
  translationModel: 'gemini-3.1-flash-lite-preview'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCodeFences(text) {
  const body = String(text || '').trim();
  const match = body.match(/^```(?:srt|text)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : body;
}

function buildPrompt(targetLanguage, srt) {
  return [
    `Translate the following SRT subtitles into ${targetLanguage}.`,
    'Return JSON that matches the provided schema exactly.',
    'Keep the same number of subtitle entries.',
    'Each output item must correspond to exactly one input subtitle index.',
    'Do not merge, split, summarize, explain, omit, or reorder entries.',
    'Translate only the subtitle text.',
    'Do not include markdown fences or extra commentary.',
    '',
    srt
  ].join('\n');
}

function buildTranslationSchema(entryCount) {
  return {
    type: 'array',
    minItems: entryCount,
    maxItems: entryCount,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: {
          type: 'integer',
          description: 'Original 1-based subtitle index from the input SRT.'
        },
        text: {
          type: 'string',
          description: 'Translated subtitle text for that index.'
        }
      },
      required: ['index', 'text']
    }
  };
}

function parseStructuredTranslation(text) {
  const body = stripCodeFences(text);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`Gemini の JSON 応答を解析できませんでした: ${error?.message || 'parse failed'}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini の構造化応答が配列ではありません。');
  }

  return parsed.map((entry) => ({
    index: Number(entry?.index),
    text: String(entry?.text || '')
  }));
}

async function callGemini({ apiKey, model, targetLanguage, srt, entryCount }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildPrompt(targetLanguage, srt) }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: buildTranslationSchema(entryCount),
      temperature: 0.2,
      topP: 0.95,
      topK: 20
    }
  };

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let retryable = false;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message || `Gemini API error: ${response.status}`;
        retryable = response.status === 429 || response.status >= 500;
        throw new Error(message);
      }

      const text = payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).map((part) => part?.text || '').join('\n').trim();
      if (!text) {
        throw new Error('Gemini から翻訳本文を受け取れませんでした。');
      }

      return parseStructuredTranslation(text);
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error('Gemini の呼び出しに失敗しました。');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'translateWindow') return false;

  (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_DEFAULTS);
      const apiKey = String(stored.translationApiKey || '').trim();
      const model = String(message.model || stored.translationModel || '').trim();

      if (!stored.translationEnabled) {
        throw new Error('翻訳設定が無効です。');
      }
      if (!apiKey) {
        throw new Error('Gemini API Key が未設定です。');
      }
      if (!model) {
        throw new Error('Gemini model が未設定です。');
      }

      const srt = await callGemini({
        apiKey,
        model,
        targetLanguage: message.targetLanguage || 'Japanese',
        srt: message.srt || '',
        entryCount: Number(message.entryCount || 0)
      });

      sendResponse({
        ok: true,
        requestKey: message.requestKey,
        entries: srt
      });
    } catch (error) {
      sendResponse({
        ok: false,
        requestKey: message?.requestKey,
        error: error?.message || '翻訳処理に失敗しました。'
      });
    }
  })();

  return true;
});
