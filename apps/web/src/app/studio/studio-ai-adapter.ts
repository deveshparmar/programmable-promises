import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

function textFromResponse(response: AgLlmResponse): string {
  for (const item of response.output ?? []) {
    const row = item as { content?: { text?: string }[] };
    const chunk = row.content?.find((part) => typeof part.text === "string");
    if (chunk?.text) return chunk.text;
  }
  return "No response from the model.";
}

/** Routes Studio agent turns through the API so keys stay on the server. */
export function createStudioProxyAdapter(token: () => string | null): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options) {
      const complete = fetch("/api/studio/llm-turn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        },
        body: JSON.stringify(request),
        signal: options?.signal,
      }).then(async (response) => {
        const body = await response.text();
        if (!response.ok) {
          let message = `LLM proxy failed (${response.status})`;
          try {
            const json = JSON.parse(body) as { error?: { message?: string } };
            if (json.error?.message) message = json.error.message;
          } catch {
            if (body.trim()) message = body.slice(0, 300);
          }
          throw new Error(message);
        }
        return JSON.parse(body) as AgLlmResponse;
      });

      const stream = {
        async *[Symbol.asyncIterator](): AsyncIterator<AgAiEvent> {
          const result = await complete;
          const messageId = result.id;
          const text = textFromResponse(result);
          yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
          yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text };
          yield { type: "TEXT_MESSAGE_END", messageId };
        },
      };

      return { stream, complete };
    },
  };
}
