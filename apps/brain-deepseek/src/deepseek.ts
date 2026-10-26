/**
 * Thin OpenAI-compatible client for the DeepSeek API.
 *
 * itto's brain is a small agent loop: a few chat completions plus MCP tool
 * calls per nudge. One fetch beats pulling in an agent framework, and anything
 * OpenAI-compatible works by pointing DEEPSEEK_BASE_URL somewhere else.
 *
 * Docs: https://api-docs.deepseek.com/
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-style wire message. Kept loose on purpose — we pass through verbatim. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * 要不要「深度思考」（reasoning）。默认**关**。
   *
   * 实测（2026-10，真实对局日志）：
   *   pro 开思考   平均 25.7 秒一次唤醒，最慢 116.8 秒
   *   pro 关思考   平均 1.2~1.8 秒（同样的工具调用能力）
   * 游戏是实时的 —— 一次唤醒 26 秒，玩家只会觉得"它不动了"。
   * 想要更聪明的判断可以 BRAIN_THINKING=true 换回来。
   */
  thinking?: boolean;
}

export class DeepSeekError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
  }
}

export const DEEPSEEK_DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  temperature: 0.8,
  maxTokens: 2048,
  timeoutMs: 60_000,
  maxRetries: 2,
  thinking: false,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(4000, 700 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof DeepSeekError) {
    return err.status === 429 || (err.status !== undefined && err.status >= 500);
  }
  return true; // network hiccup / timeout / abort — worth one more try
}

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly thinking: boolean;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) {
      throw new DeepSeekError("DEEPSEEK_API_KEY is not set (put it in .env at the repo root)");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEEPSEEK_DEFAULTS.baseUrl).replace(/\/+$/, "");
    this.modelName = opts.model ?? DEEPSEEK_DEFAULTS.model;
    this.temperature = opts.temperature ?? DEEPSEEK_DEFAULTS.temperature;
    this.maxTokens = opts.maxTokens ?? DEEPSEEK_DEFAULTS.maxTokens;
    this.timeoutMs = opts.timeoutMs ?? DEEPSEEK_DEFAULTS.timeoutMs;
    this.maxRetries = opts.maxRetries ?? DEEPSEEK_DEFAULTS.maxRetries;
    this.thinking = opts.thinking ?? DEEPSEEK_DEFAULTS.thinking;
  }

  get model(): string {
    return this.modelName;
  }

  /**
   * One chat completion. Returns the assistant message, tool_calls and all.
   * Retries 429/5xx/network errors with exponential backoff, then gives up.
   */
  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    };
    // 关掉深度思考：不关的话模型会先"想"几十秒再动手，游戏里就是卡着不动。
    // 两个模型都认这个参数（不认的会被它在服务端忽略，不会报错）。
    if (!this.thinking) body.thinking = { type: "disabled" };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.baseUrl + "/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + this.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          const detail = (await res.text()).slice(0, 500);
          throw new DeepSeekError("DeepSeek HTTP " + res.status + ": " + detail, res.status);
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
        };
        const message = data.choices?.[0]?.message;
        if (!message) {
          throw new DeepSeekError("DeepSeek returned no choices: " + JSON.stringify(data).slice(0, 300));
        }
        return {
          role: "assistant",
          content: message.content ?? null,
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        };
      } catch (e) {
        lastErr = e;
        if (attempt < this.maxRetries && isRetryable(e)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw e;
      }
    }

    throw lastErr instanceof Error ? lastErr : new DeepSeekError("DeepSeek request failed");
  }
}
