const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 15_000;

/** A Gemini call failed: HTTP error (429 = free-tier quota used up), timeout, or no usable text. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface JsonRequest {
  systemInstruction: string;
  prompt: string;
  /** Gemini response schema (OpenAPI subset). The model is forced to answer with JSON of this shape. */
  schema: object;
}

/** Sends one prompt and returns the model's JSON answer, parsed but not yet validated. */
export type GenerateJson = (request: JsonRequest) => Promise<unknown>;

export interface GeminiClientOptions {
  apiKey: string;
  /** Model id from AI Studio, with or without the "models/" prefix. */
  model: string;
  timeoutMs?: number;
  /** Injected in tests so they never call the real API. */
  fetch?: typeof fetch;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

/**
 * Minimal Gemini REST client (generateContent with JSON output). The key goes in
 * the x-goog-api-key header, never in the URL, so it does not end up in logs.
 */
export function createGeminiClient({ apiKey, model, timeoutMs = TIMEOUT_MS, fetch: fetchFn = fetch }: GeminiClientOptions): GenerateJson {
  const url = `${API_BASE}/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;

  return async ({ systemInstruction, prompt, schema }) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GeminiError(`Gemini request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new GeminiError(`Gemini answered HTTP ${res.status}`, res.status);

    const body = (await res.json()) as GenerateContentResponse;
    // Thinking models may return "thought" parts before the answer; only the answer is JSON.
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    if (!text) throw new GeminiError('Gemini returned no text');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GeminiError('Gemini returned invalid JSON');
    }
  };
}
