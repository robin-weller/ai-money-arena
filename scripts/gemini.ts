type GeminiDecision = {
  action?: string;
  status?: string;
  reason?: string;
  task?: string;
};

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_TOKENS = 220;

function buildGeminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function extractTextResponse(payload: any): string {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text content.");
  }

  return text;
}

function parseJsonFromText(text: string): GeminiDecision {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  return JSON.parse(candidate);
}

export async function callGemini(
  prompt: string,
  options: { model?: string; timeoutMs?: number; maxOutputTokens?: number } = {}
): Promise<GeminiDecision> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${buildGeminiUrl(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json"
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const payload = await response.json();
    const text = extractTextResponse(payload);
    return parseJsonFromText(text);
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
