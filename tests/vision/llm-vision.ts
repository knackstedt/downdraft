export interface LLMVisionOptions {
  prompt: string;
  imageData: Uint8Array;
  format?: "png" | "jpeg";
  model?: string;
  apiKey?: string;
  endpoint?: string;
}

export interface LLMVisionResult {
  passed: boolean;
  reasoning: string;
  confidence: number;
}

export async function llmVisionVerify(
  options: LLMVisionOptions,
): Promise<LLMVisionResult> {
  const {
    prompt,
    imageData,
    format = "png",
    model = "gpt-4o",
    apiKey = process.env.OPENAI_API_KEY,
    endpoint = "https://api.openai.com/v1/chat/completions",
  } = options;

  if (!apiKey) {
    return {
      passed: false,
      reasoning: "No API key provided. Set OPENAI_API_KEY environment variable.",
      confidence: 0,
    };
  }

  const base64 = btoa(String.fromCharCode(...imageData));
  const dataUrl = `data:image/${format};base64,${base64}`;

  const systemPrompt = `You are a vision test verifier. You will be shown a screenshot of a game engine render. Answer whether the screenshot matches the description. Respond in JSON format: {"passed": boolean, "reasoning": string, "confidence": number (0-1)}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: `Does this screenshot show: ${prompt}?` },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      return {
        passed: false,
        reasoning: `API request failed: ${response.status} ${response.statusText}`,
        confidence: 0,
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    try {
      const parsed = JSON.parse(content);
      return {
        passed: Boolean(parsed.passed),
        reasoning: String(parsed.reasoning ?? ""),
        confidence: Number(parsed.confidence ?? 0),
      };
    } catch {
      const passed = content.toLowerCase().includes("yes") || content.toLowerCase().includes("passed");
      return {
        passed,
        reasoning: content,
        confidence: passed ? 0.7 : 0.3,
      };
    }
  } catch (e) {
    return {
      passed: false,
      reasoning: `Request error: ${e instanceof Error ? e.message : String(e)}`,
      confidence: 0,
    };
  }
}

export async function llmVisionBatch(
  screenshots: Array<{ name: string; data: Uint8Array; prompt: string }>,
): Promise<Array<{ name: string; result: LLMVisionResult }>> {
  const results: Array<{ name: string; result: LLMVisionResult }> = [];
  for (let _i = 0, _it = screenshots, _n = _it.length; _i < _n; _i++) { const screenshot = _it[_i];
    const result = await llmVisionVerify({
      prompt: screenshot.prompt,
      imageData: screenshot.data,
    });
    results.push({ name: screenshot.name, result });
  }
  return results;
}
