const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 3000];

const INPUT_COST_PER_TOKEN = 0.0000001;
const OUTPUT_COST_PER_TOKEN = 0.0000004;

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function trimForLog(value, limit = 600) {
  return String(value || "").slice(0, limit);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyError(err) {
  const msg = err.message || '';
  if (err.name === 'AbortError' || msg.includes('timed out')) return 'timeout';
  if (msg.includes('invalid JSON') || msg.includes('no candidates') || msg.includes('empty text')) return 'invalid_response';
  return 'api_error';
}

function isRetryable(errorType) {
  return errorType === 'timeout' || errorType === 'api_error';
}

function extractTextResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || !String(text).trim()) {
    throw new Error("Gemini returned no candidates or empty text.");
  }

  return String(text).trim();
}

async function attemptGeminiCall(prompt, options) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${buildGeminiUrl(model)}?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    console.log(`[gemini] response.status=${response.status}`);
    console.log(`[gemini] response.body=${trimForLog(responseText)}`);

    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`Gemini returned invalid JSON response: ${error.message}`);
    }

    return {
      text: extractTextResponse(payload),
      status: response.status,
      usage: (function () {
        const meta = payload?.usageMetadata || {};
        const promptTokens = meta.promptTokenCount || 0;
        const outputTokens = meta.candidatesTokenCount || 0;
        const cost = (promptTokens * INPUT_COST_PER_TOKEN) + (outputTokens * OUTPUT_COST_PER_TOKEN);
        return { promptTokens, outputTokens, cost };
      })(),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms.`);
    }
    console.log(`[gemini] error.message=${trimForLog(error.message)}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(prompt, options = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] || 3000;
      const errorType = classifyError(lastError);
      console.log(`[gemini] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms (reason: ${errorType})`);
      await sleep(delay);
    }

    try {
      const result = await attemptGeminiCall(prompt, options);
      if (attempt > 0) console.log(`[gemini] Succeeded on retry ${attempt}`);
      return result;
    } catch (err) {
      lastError = err;
      const errorType = classifyError(err);
      console.log(`[gemini] Attempt ${attempt + 1} failed: ${errorType} — ${err.message}`);
      if (!isRetryable(errorType)) break; // don't retry parse/response errors
    }
  }

  // All attempts exhausted — return structured failure
  const errorType = classifyError(lastError);
  return {
    success: false,
    error: errorType,
    message: lastError.message,
    retryable: isRetryable(errorType),
  };
}

module.exports = { callGemini };
