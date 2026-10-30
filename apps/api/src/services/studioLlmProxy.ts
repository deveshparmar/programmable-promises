import { aiChatUrl, config } from "../config.js";
import { HttpError } from "../errors.js";

type OpenAiMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; content: string; tool_call_id: string };

interface StudioToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function textFromInputContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as { type?: string; text?: string };
      if (row.type === "text" && typeof row.text === "string") return row.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function textFromOutputContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as { type?: string; text?: string; refusal?: string };
      if (row.type === "text" && typeof row.text === "string") return row.text;
      if (row.type === "refusal" && typeof row.refusal === "string") return row.refusal;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messagesFromStudioBody(body: unknown): OpenAiMessage[] {
  const request = body as {
    instructions?: string;
    input?: unknown[];
  };
  const messages: OpenAiMessage[] = [];
  if (request.instructions?.trim()) {
    messages.push({ role: "system", content: request.instructions.trim() });
  }
  for (const item of request.input ?? []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.kind === "input" && row.type === "message") {
      const role = row.role === "system" ? "system" : "user";
      const text = textFromInputContent(row.content);
      if (text) messages.push({ role, content: text });
      continue;
    }
    if (row.kind === "output" && row.type === "message") {
      const text = textFromOutputContent(row.content);
      if (text) messages.push({ role: "assistant", content: text });
      continue;
    }
    if (row.type === "function_call_output" && typeof row.callId === "string") {
      messages.push({
        role: "tool",
        tool_call_id: row.callId,
        content: typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? ""),
      });
      continue;
    }
    if (row.type === "function_call" && typeof row.callId === "string") {
      messages.push({
        role: "assistant",
        content: "",
        // OpenAI expects tool_calls on assistant - simplified: skip; tool results usually follow
      });
    }
  }
  if (!messages.length) {
    messages.push({ role: "user", content: "Continue." });
  }
  return messages;
}

function openAiTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const row = tool as StudioToolSchema;
      if (!row.name) return null;
      return {
        type: "function",
        function: {
          name: row.name,
          description: row.description ?? "",
          parameters: row.parameters ?? { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function apiErrorMessage(parsed: Record<string, unknown>, fallback: string): string {
  const err = parsed.error;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: string }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof parsed.message === "string") return parsed.message;
  return fallback;
}

function studioModel(requestModel: unknown): string {
  const requested = typeof requestModel === "string" ? requestModel : "";
  if (config.aiProvider === "gemini") {
    if (requested && !requested.startsWith("gpt") && !requested.startsWith("o1") && !requested.startsWith("o3")) {
      return requested;
    }
    return config.aiModel;
  }
  return requested || config.aiModel;
}

/** Proxies AG Studio agent turns to the configured OpenAI-compatible API (server-side key). */
export async function proxyStudioTurn(body: unknown): Promise<unknown> {
  if (!config.aiApiKey || config.aiProvider === "mock") {
    throw new HttpError(
      503,
      "STUDIO_AI_NOT_CONFIGURED",
      "Set AI_API_KEY (and AI_PROVIDER openai or gemini) to use the dashboard AI assistant.",
    );
  }

  const request = body as { model?: string; tools?: unknown[] };
  const messages = messagesFromStudioBody(body);
  const model = studioModel(request.model);
  const url = aiChatUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.aiApiKey}`,
  };
  if (config.aiProvider === "gemini") {
    headers["x-goog-api-key"] = config.aiApiKey;
  }

  const tools = openAiTools(request.tools);
  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
  };
  if (tools?.length) payload.tools = tools;

  const models =
    config.aiProvider === "gemini"
      ? [...new Set([model, config.aiModel, "gemini-2.0-flash", "gemini-2.5-flash", "gemini-3.5-flash-lite"])]
      : [model];

  let response: Response | undefined;
  let parsed: Record<string, unknown> = {};
  let lastError = "LLM request failed";

  for (const attemptModel of models) {
    payload.model = attemptModel;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      continue;
    }
    const text = await response.text();
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
    if (response.ok) break;
    lastError = apiErrorMessage(parsed, `Upstream returned ${response.status}`);
    if (response.status !== 404 && response.status !== 400) break;
  }

  if (!response?.ok) {
    throw new HttpError(502, "STUDIO_LLM_ERROR", lastError);
  }

  const choice = (parsed.choices as
    | {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
        };
      }[]
    | undefined)?.[0];
  const message = choice?.message;
  const id = crypto.randomUUID();
  const now = Date.now();
  const output: Record<string, unknown>[] = [];

  if (message?.tool_calls?.length) {
    for (const call of message.tool_calls) {
      output.push({
        type: "function_call",
        id: crypto.randomUUID(),
        kind: "output",
        callId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: "completed",
      });
    }
  }

  const content = typeof message?.content === "string" ? message.content : "";
  if (content.trim()) {
    output.push({
      type: "message",
      id: `${id}-msg`,
      kind: "output",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: content, annotations: [] }],
    });
  }

  if (!output.length) {
    output.push({
      type: "message",
      id: `${id}-msg`,
      kind: "output",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: "Done.", annotations: [] }],
    });
  }

  return {
    id,
    createdAt: now,
    status: "completed",
    output,
  };
}
