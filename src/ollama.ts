export interface OllamaChatInput {
  prompt: string;
  model?: string;
}

export interface OllamaChatResult {
  model: string;
  content: string;
}

const OLLAMA_TIMEOUT_MS = 30000;

export async function ollamaChat(input: OllamaChatInput): Promise<OllamaChatResult> {
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OLLAMA_NOT_CONFIGURED');
  }

  const model = input.model ?? 'glm-5.3-flash';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: input.prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new Error(`OLLAMA_HTTP_${response.status}`);
    }

    let data: { model?: string; message?: { content?: string } };
    try {
      data = (await response.json()) as { model?: string; message?: { content?: string } };
    } catch {
      throw new Error('OLLAMA_INVALID_RESPONSE');
    }

    return {
      model: data.model ?? model,
      content: data.message?.content ?? '',
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OLLAMA_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
