const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 20000;

const INPUT_COST_PER_TOKEN = 0.0000001;
const OUTPUT_COST_PER_TOKEN = 0.0000004;

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function trimForLog(value, limit = 600) {
  return String(value || "").slice(0, limit);
}

function extractTextResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || !String(text).trim()) {
    throw new Error("Gemini returned no candidates or empty text.");
  }

  return String(text).trim();
}

async function callGemini(prompt, options = {}) {
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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
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

module.exports = {
  callGemini
};
