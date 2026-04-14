type GeminiDecision = {
  action?: string;
  status?: string;
  reason?: string;
  task?: string;
};

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 20000;

function buildGeminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function trimForLog(value: unknown, limit = 600): string {
  return String(value || "").slice(0, limit);
}

function extractTextResponse(payload: any): string {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || !String(text).trim()) {
    throw new Error("Gemini returned no candidates or empty text.");
  }

  return String(text).trim();
}

export async function callGemini(
  prompt: string,
  options: { model?: string; timeoutMs?: number; maxOutputTokens?: number } = {}
): Promise<string> {
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
            parts: [{ text: prompt }]
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

    let payload: any;
    try {
      payload = JSON.parse(responseText);
    } catch (error: any) {
      throw new Error(`Gemini returned invalid JSON response: ${error.message}`);
    }

    return extractTextResponse(payload);
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms.`);
    }

    console.log(`[gemini] error.message=${trimForLog(error.message)}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
