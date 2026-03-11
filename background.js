const GEMINI_PROVIDER = 'gemini';
const ZAI_PROVIDER = 'z-ai';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const ZAI_DEFAULT_MODEL = 'glm-4.5-air';
const ZAI_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

const STORAGE_DEFAULTS = {
  translationEnabled: false,
  translationProvider: GEMINI_PROVIDER,
  translationApiKey: '',
  translationModel: GEMINI_DEFAULT_MODEL,
  translationGeminiApiKey: '',
  translationGeminiModel: GEMINI_DEFAULT_MODEL,
  translationZaiApiKey: '',
  translationZaiModel: ZAI_DEFAULT_MODEL
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCodeFences(text) {
  const body = String(text || '').trim();
  const match = body.match(/^```(?:json|javascript|text|srt)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : body;
}

function getProviderMeta(provider = GEMINI_PROVIDER) {
  if (provider === ZAI_PROVIDER) {
    return {
      id: ZAI_PROVIDER,
      label: 'Z.AI',
      apiKeyLabel: 'Z.AI API Key',
      modelLabel: 'Z.AI Model',
      defaultModel: ZAI_DEFAULT_MODEL,
      apiKeyKey: 'translationZaiApiKey',
      modelKey: 'translationZaiModel'
    };
  }

  return {
    id: GEMINI_PROVIDER,
    label: 'Gemini',
    apiKeyLabel: 'Gemini API Key',
    modelLabel: 'Gemini Model',
    defaultModel: GEMINI_DEFAULT_MODEL,
    apiKeyKey: 'translationGeminiApiKey',
    modelKey: 'translationGeminiModel'
  };
}

function getStoredTranslationConfig(stored, provider = stored?.translationProvider || GEMINI_PROVIDER) {
  const meta = getProviderMeta(provider);
  const apiKey = String(stored?.[meta.apiKeyKey] || stored?.translationApiKey || '').trim();
  const providerModel = String(stored?.[meta.modelKey] || '').trim();
  const legacyModel = String(stored?.translationModel || '').trim();
  const model =
    provider === GEMINI_PROVIDER && providerModel === meta.defaultModel && legacyModel && legacyModel !== providerModel
      ? legacyModel
      : (providerModel || legacyModel || meta.defaultModel);

  return {
    provider,
    apiKey,
    model,
    meta
  };
}

function buildPrompt(targetLanguage, srt) {
  return [
    `Translate the following SRT subtitles into ${targetLanguage}.`,
    'Return a JSON array only.',
    'Keep the same number of subtitle entries.',
    'Each output item must correspond to exactly one input subtitle index.',
    'Do not merge, split, summarize, explain, omit, or reorder entries.',
    'Translate only the subtitle text.',
    'Each item must be shaped as {"index": number, "text": string}.',
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

function parseStructuredTranslation(text, providerLabel) {
  const body = stripCodeFences(text);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${providerLabel} の JSON 応答を解析できませんでした: ${error?.message || 'parse failed'}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${providerLabel} の構造化応答が配列ではありません。`);
  }

  return parsed.map((entry) => ({
    index: Number(entry?.index),
    text: String(entry?.text || '')
  }));
}

function extractZAiMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
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
        throw new Error(message);
      }

      const text = payload?.candidates
        ?.flatMap((candidate) => candidate?.content?.parts || [])
        .map((part) => part?.text || '')
        .join('\n')
        .trim();
      if (!text) {
        throw new Error('Gemini から翻訳本文を受け取れませんでした。');
      }

      return parseStructuredTranslation(text, 'Gemini');
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

async function callZAi({ apiKey, model, targetLanguage, srt }) {
  const url = `${ZAI_CODING_BASE_URL}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    thinking: {
      type: 'disabled'
    },
    messages: [
      {
        role: 'system',
        content: 'You are a subtitle translation engine. Return only a JSON array.'
      },
      {
        role: 'user',
        content: buildPrompt(targetLanguage, srt)
      }
    ]
  };

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `Z.AI API error: ${response.status}`;
        throw new Error(message);
      }

      const text = extractZAiMessageText(payload);
      if (!text) {
        throw new Error('Z.AI から翻訳本文を受け取れませんでした。');
      }

      return parseStructuredTranslation(text, 'Z.AI');
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error('Z.AI の呼び出しに失敗しました。');
}

async function translateWithProvider({ provider, apiKey, model, targetLanguage, srt, entryCount }) {
  if (provider === ZAI_PROVIDER) {
    return callZAi({
      apiKey,
      model,
      targetLanguage,
      srt,
      entryCount
    });
  }

  return callGemini({
    apiKey,
    model,
    targetLanguage,
    srt,
    entryCount
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'translateWindow') return false;

  (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_DEFAULTS);
      const provider = String(message.provider || stored.translationProvider || GEMINI_PROVIDER).trim() || GEMINI_PROVIDER;
      const config = getStoredTranslationConfig(stored, provider);
      const apiKey = config.apiKey;
      const model = String(message.model || config.model || '').trim();

      if (!stored.translationEnabled) {
        throw new Error('翻訳設定が無効です。');
      }
      if (!apiKey) {
        throw new Error(`${config.meta.apiKeyLabel} が未設定です。`);
      }
      if (!model) {
        throw new Error(`${config.meta.modelLabel} が未設定です。`);
      }

      const entries = await translateWithProvider({
        provider,
        apiKey,
        model,
        targetLanguage: message.targetLanguage || 'Japanese',
        srt: message.srt || '',
        entryCount: Number(message.entryCount || 0)
      });

      sendResponse({
        ok: true,
        requestKey: message.requestKey,
        entries
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
