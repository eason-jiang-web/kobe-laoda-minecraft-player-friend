/**
 * End-to-end smoke test for the DeepSeek brain - no Minecraft, no API key,
 * no money spent.
 *
 * It stands up two fakes:
 *   - a DeepSeek-shaped /chat/completions endpoint that asks for one `chat` tool call
 *   - a real itto MCP server (the same serveHttp the bot uses) with a fake `chat` tool
 * then spawns the brain exactly the way the slow loop does and asserts the
 * tool call actually landed.
 *
 *   bun run --cwd apps/brain-deepseek smoke
 */
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveHttp } from "@itto/mcp-server";
import { z } from "zod";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BRAIN = resolve(REPO_ROOT, "apps", "brain-deepseek", "src", "index.ts");
const HISTORY = resolve(REPO_ROOT, "data", "smoke-brain-history.json");

interface ModelRequest {
  model?: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
}

/** A port the OS just told us was free. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || !detail ? "" : " -> " + detail));
  if (!ok) failures.push(label);
}

// ── fake DeepSeek ──────────────────────────────────────────────────────────
const modelRequests: ModelRequest[] = [];
const modelServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json()) as ModelRequest;
    modelRequests.push(body);
    const sawToolResult = body.messages.some((m) => m.role === "tool");
    if (!sawToolResult) {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_smoke_1",
                  type: "function",
                  function: { name: "chat", arguments: JSON.stringify({ message: "yo from the mock" }) },
                },
              ],
            },
          },
        ],
      });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "done, nothing else worth saying" } }] });
  },
});

// ── a real itto MCP server with a fake body ────────────────────────────────
const chatCalls: string[] = [];
const mcpPort = freePort();
const mcpHttp = await serveHttp(
  () => {
    const server = new McpServer({ name: "itto-smoke", version: "0.0.0" });
    server.tool("chat", "Send a message in Minecraft text chat.", { message: z.string() }, async ({ message }) => {
      chatCalls.push(message);
      return { content: [{ type: "text" as const, text: "sent" }] };
    });
    server.resource(
      "game-state-text",
      "itto://state/current.txt",
      { description: "Live world snapshot as text.", mimeType: "text/plain" },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/plain", text: "time=day\nme: hp=20 food=20" }],
      }),
    );
    return server;
  },
  { host: "127.0.0.1", port: mcpPort },
);

console.log("smoke: mock model on :" + modelServer.port + ", mock itto-mc on :" + mcpPort);

try {
  const proc = Bun.spawn([process.execPath, BRAIN, 'eason said "牢大 过来"'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "sk-smoke-test-not-a-real-key",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:" + modelServer.port,
      DEEPSEEK_MODEL: "deepseek-flash",
      ITTO_MCP_URL: "http://127.0.0.1:" + mcpPort + "/mcp",
      BRAIN_HISTORY_PATH: HISTORY,
      BRAIN_DEBUG: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  console.log("--- brain stdout ---\n" + stdout.trim());
  console.log("--- brain stderr ---\n" + stderr.trim());
  console.log("--- assertions ---");

  check("brain exited 0", code === 0, "exit " + code);
  check("model got the full tool surface", (modelRequests[0]?.tools ?? []).some((t) => t.function.name === "chat"));
  check("model got resources as read_resource", (modelRequests[0]?.tools ?? []).some((t) => t.function.name === "read_resource"));
  check("system prompt carries the persona", JSON.stringify(modelRequests[0]?.messages[0]?.content ?? "").includes("牢大"));
  check(
    "the prompt survived argv encoding (CJK)",
    Boolean(modelRequests[0]?.messages.some((m) => m.role === "user" && m.content === 'eason said "牢大 过来"')),
    JSON.stringify(modelRequests[0]?.messages.find((m) => m.role === "user")?.content),
  );
  check("tool call reached the MCP server", chatCalls.length === 1, JSON.stringify(chatCalls));
  check("tool call carried the right args", chatCalls[0] === "yo from the mock", String(chatCalls[0]));
  check("tool result was fed back to the model", modelRequests.length === 2, modelRequests.length + " model calls");
  check("final answer was remembered", modelRequests.length === 2 && stdout.includes("stayed quiet") === false);
} finally {
  await mcpHttp.close();
  modelServer.stop(true);
  rmSync(HISTORY, { force: true });
}

console.log(failures.length === 0 ? "\nSMOKE PASS" : "\nSMOKE FAIL: " + failures.join("; "));
process.exit(failures.length === 0 ? 0 : 1);
