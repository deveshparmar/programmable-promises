#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "./api-client.js";

const apiBase = (process.env.PP_API_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "");
const client = new ApiClient(apiBase);

function textResult(data: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

async function runTool(fn: () => Promise<unknown>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return textResult(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const server = new McpServer(
  {
    name: "programmable-promises",
    version: "0.1.0",
  },
  {
    instructions: [
      "Tools for the Programmable Promises hackathon app (PayPal hold + AI photo verification).",
      "Payer flows: pp_login, pp_create_promise, pp_confirm_checklist, pp_create_funding_order, then the human completes PayPal Buttons in the web UI.",
      "Worker flows: use promise_id + share_token from create response with pp_issue_challenge and pp_submit_proof.",
      "Pair with PayPal's official @paypal/mcp server for direct sandbox API tasks (invoices, balances, etc.).",
      `API base: ${apiBase}`,
    ].join(" "),
  },
);

server.registerTool(
  "pp_health",
  {
    description: "Check API, Postgres, Redis, Kafka, PayPal, and AI configuration status.",
    inputSchema: {},
  },
  async () => runTool(() => client.health()),
);

server.registerTool(
  "pp_login",
  {
    description: "Sign in as a payer (demo auth: any valid email, no password). Stores JWT for other pp_* tools.",
    inputSchema: {
      email: z.string().email().describe("Payer email"),
    },
  },
  async ({ email }) => runTool(() => client.login(email)),
);

server.registerTool(
  "pp_list_promises",
  {
    description: "List promises for the signed-in payer.",
    inputSchema: {},
  },
  async () => runTool(() => client.listPromises()),
);

server.registerTool(
  "pp_get_promise",
  {
    description: "Get one promise with checklist. Payer JWT or worker share_token.",
    inputSchema: {
      promise_id: z.string().uuid(),
      share_token: z.string().min(16).optional().describe("Worker link token; omit when signed in as payer"),
    },
  },
  async ({ promise_id, share_token }) => runTool(() => client.getPromise(promise_id, share_token)),
);

server.registerTool(
  "pp_create_promise",
  {
    description:
      "Create a promise: AI generates a checklist from the description. Returns worker_url and share_token (show once).",
    inputSchema: {
      description: z.string().min(10).max(4000),
      amount_minor: z.number().int().min(100).max(1_000_000).describe("USD cents, e.g. 4000 = $40"),
      worker_email: z.string().email(),
      deadline_at: z.string().describe("ISO datetime, max ~48h ahead"),
      title: z.string().min(1).max(140).optional(),
    },
  },
  async (body) =>
    runTool(() =>
      client.createPromise({
        description: body.description,
        amount_minor: body.amount_minor,
        worker_email: body.worker_email,
        deadline_at: body.deadline_at,
        ...(body.title ? { title: body.title } : {}),
      }),
    ),
);

server.registerTool(
  "pp_confirm_checklist",
  {
    description: "Edit or confirm the checklist so the promise can be funded. Set confirm true when ready.",
    inputSchema: {
      promise_id: z.string().uuid(),
      items: z
        .array(
          z.object({
            text: z.string().min(3).max(400),
            weight: z.number().positive().max(100),
            required: z.boolean(),
          }),
        )
        .min(1)
        .max(8),
      pass_threshold: z.number().min(0.5).max(1).optional(),
      confirm: z.boolean().optional(),
      deadline_at: z.string().optional(),
    },
  },
  async ({ promise_id, ...rest }) => runTool(() => client.confirmChecklist(promise_id, rest)),
);

server.registerTool(
  "pp_create_funding_order",
  {
    description:
      "Create a PayPal AUTHORIZE order for a confirmed promise. Returns order id; payer must approve with PayPal Buttons in the web app.",
    inputSchema: {
      promise_id: z.string().uuid(),
    },
  },
  async ({ promise_id }) => runTool(() => client.createFundingOrder(promise_id)),
);

server.registerTool(
  "pp_get_verifications",
  {
    description: "List AI verification runs (verdict, evidence per checklist item).",
    inputSchema: {
      promise_id: z.string().uuid(),
      share_token: z.string().min(16).optional(),
    },
  },
  async ({ promise_id, share_token }) => runTool(() => client.listVerifications(promise_id, share_token)),
);

server.registerTool(
  "pp_issue_challenge",
  {
    description: "Worker: get a challenge code to show in the proof photo.",
    inputSchema: {
      promise_id: z.string().uuid(),
      share_token: z.string().min(16),
    },
  },
  async ({ promise_id, share_token }) => runTool(() => client.issueChallenge(promise_id, share_token)),
);

server.registerTool(
  "pp_submit_proof",
  {
    description: "Worker: upload a local jpg/png path; triggers AI verification and may start payment when Kafka is enabled.",
    inputSchema: {
      promise_id: z.string().uuid(),
      share_token: z.string().min(16),
      image_path: z.string().min(1).describe("Absolute or relative path to jpg/png on this machine"),
    },
  },
  async ({ promise_id, share_token, image_path }) =>
    runTool(() => client.submitProof(promise_id, share_token, image_path)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
