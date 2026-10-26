/**
 * Typed config loaded from environment. Fails loud and early if something
 * required is missing — better than a cryptic Mineflayer error 10s in.
 */
import { parseAllowedCommands } from "./server-commands.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export interface Config {
  mc: {
    host: string;
    port: number;
    version: string;
    username: string;
    auth: "offline" | "microsoft";
    ownerUsername: string;
    /**
     * Words that mean "the player is talking to me" (case-insensitive).
     * Always includes the bot's own in-game name. Set with MC_WAKE_WORDS.
     */
    wakeWords: string[];
    /**
     * Reply to ANYTHING the owner types, not just lines that name the bot.
     * A LAN world is a two-person conversation; waiting to be named is what
     * makes a companion feel like a tool. MC_CHAT_REPLY_ALL.
     */
    chatReplyAll: boolean;
    /**
     * Server commands the bot may run through the chat bar. "*" = everything
     * (dangerous: /fill and /stop live there). Parsed by server-commands.ts.
     */
    allowedCommands: string[] | "*";
    /**
     * 开机时自己给自己发一次 /op。玩家没权限，所以这条**注定被拒** ——
     * 但值得发：万一你已经给过，这里就当确认；被拒时它在游戏里提示你一句，
     * 省得你去翻终端。MC_SELF_OP（默认开）。
     */
    selfOp: boolean;
    /**
     * 你的 Minecraft 游戏目录（PCL 版本隔离时是 `...\.minecraft\versions\<版本>`）。
     * 用途：读官方中文语言文件（让牢大眼里的物品是中文），以及「给牢大开权限.cmd」
     * 找存档。不填就自动找。MC_GAME_DIR。
     */
    gameDir?: string;
  };
  mcp: {
    host: string;
    port: number;
  };
  tuning: {
    fastLoopHz: number;
    slowLoopIntervalMs: number;
    followTargetRange: number;
    teleportFallbackDistance: number;
    /** How often to wake the brain to reassess even with no event (0 = off). */
    heartbeatMs: number;
    /** Inventory milestones worth reporting, e.g. "any_log:128,rare:10". */
    reportItems: string;
    /**
     * Autoplay: when nothing is happening and no goal is running, wake the brain
     * with "go find something useful to do" instead of a plain heartbeat, so it
     * plays on its own. MC_AUTOPLAY.
     */
    autoplay: boolean;
  };
  brain: {
    /** When true, route slow-loop nudges to an external agent instead of logging. */
    enabled: boolean;
    /** argv prefix to invoke the agent; the prompt is appended as the final arg. */
    cmd: string[];
    /** working directory for the agent spawn (optional). */
    dir?: string;
    cooldownMs: number;
    /** Cooldown for priority nudges (someone is talking to you right now). */
    chatCooldownMs: number;
    /**
     * 优先级唤醒（有人在跟它说话 / 有危险）用的**快模型**。
     *
     * 为什么分开：一次唤醒要调 3~4 次模型。pro 每次调用比 flash 慢 5 倍
     * （实测 5.0s vs 1.0s），你说话它要 15~20 秒才反应，看着就像"不干活"。
     * 所以：有人找你 -> 快模型（立刻反应）；它自己闲着琢磨 -> 聪明模型（想清楚）。
     * BRAIN_FAST_MODEL。
     */
    fastModel?: string;
  };
  reconnect: {
    /** Auto-rejoin when kicked/disconnected (Minehut sleeps + kicks idle bots). */
    enabled: boolean;
    delayMs: number;
    maxDelayMs: number;
  };
  logLevel: string;
}

export function loadConfig(): Config {
  // Minecraft in-game names are ASCII only, so the character has both a name
  // it goes by (the persona) and one the server accepts (this username). The
  // wake words can be anything the player would actually type at it.
  const botUsername = process.env.MC_BOT_USERNAME ?? "itto";
  const wakeWords = [
    ...new Set(
      [botUsername, ...(process.env.MC_WAKE_WORDS ?? "itto,牢大,曼巴").split(",")]
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];

  return {
    mc: {
      host: process.env.MC_SERVER_HOST ?? "localhost",
      port: num("MC_SERVER_PORT", 25565),
      version: process.env.MC_VERSION ?? "1.20.6",
      username: botUsername,
      auth: (process.env.MC_AUTH as "offline" | "microsoft") ?? "offline",
      ownerUsername: req("MC_OWNER_USERNAME"),
      wakeWords,
      chatReplyAll: (process.env.MC_CHAT_REPLY_ALL ?? "false") === "true",
      allowedCommands: parseAllowedCommands(process.env.MC_ALLOW_COMMANDS),
      selfOp: (process.env.MC_SELF_OP ?? "true") === "true",
      gameDir: process.env.MC_GAME_DIR?.trim() || undefined,
    },
    mcp: {
      host: process.env.MCP_HOST ?? "0.0.0.0",
      port: num("MCP_PORT", 3001),
    },
    tuning: {
      fastLoopHz: num("FAST_LOOP_HZ", 15),
      slowLoopIntervalMs: num("SLOW_LOOP_INTERVAL_MS", 4000),
      followTargetRange: num("FOLLOW_TARGET_RANGE", 3),
      teleportFallbackDistance: num("TELEPORT_FALLBACK_DISTANCE", 30),
      heartbeatMs: num("HEARTBEAT_MS", 30000),
      reportItems: process.env.MC_REPORT_ITEMS ?? "any_log:128,rare:10",
      autoplay: process.env.MC_AUTOPLAY === "true",
    },
    brain: {
      enabled: process.env.BRAIN_ENABLED === "true",
      cmd: (process.env.BRAIN_CMD ?? "").split(" ").filter(Boolean),
      dir: process.env.BRAIN_DIR || undefined,
      cooldownMs: num("BRAIN_COOLDOWN_MS", 10000),
      chatCooldownMs: num("BRAIN_CHAT_COOLDOWN_MS", 1500),
      fastModel: process.env.BRAIN_FAST_MODEL?.trim() || undefined,
    },
    reconnect: {
      enabled: (process.env.RECONNECT_ENABLED ?? "true") !== "false",
      delayMs: num("RECONNECT_DELAY_MS", 5000),
      maxDelayMs: num("RECONNECT_MAX_DELAY_MS", 60000),
    },
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
