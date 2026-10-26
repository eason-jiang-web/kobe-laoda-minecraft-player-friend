import type { GameState } from "@itto/shared";
import { formatStateForPrompt } from "@itto/shared";
import type { NudgeSink } from "./index.js";
import { logger } from "../util/logger.js";

const log = logger("brain");

/**
 * Routes slow-loop "nudges" into an external agent that acts as itto's brain.
 *
 * The agent is invoked as a CLI: we spawn `<cmd...> "<prompt>"` (the prompt
 * appended as the final arg) in `dir`. The agent is expected to run a model
 * that can reach this project's MCP server (itto-mc, :3001) — so it responds
 * by calling the `chat` tool (talk in MC) or acting via move_to/run_skill/etc.
 *
 * The brain stays swappable and this repo stays agnostic: any agent that takes
 * a prompt as a trailing CLI arg and can reach the itto-mc MCP server works.
 * The actual command + directory are configured locally (.env), never committed.
 */
export interface AgentBrainConfig {
  /** argv prefix to invoke the agent; the prompt is appended as the last arg. */
  cmd: string[];
  /** working directory for the spawn (so the agent loads its own config). */
  dir?: string;
  /** min ms between spawns (each is a full model run — not cheap). */
  cooldownMs: number;
  /** Shorter cooldown for priority nudges (someone is talking to you). */
  chatCooldownMs?: number;
  /**
   * 优先级唤醒用的快模型（通过 ITTO_BRAIN_MODEL 传给大脑）。
   * 有人跟你说话 = 等不起，用快的；自己闲着琢磨 = 用聪明但慢的。
   */
  fastModel?: string;
  /**
   * 每次唤醒前算一段额外提示（追问额度、画像提醒……）。返回空/null 就不加。
   * 由 index.ts 接上 memory —— 这里不认识 WorldMemory，保持解耦。
   */
  extraPrompt?: () => string | null;
}

const PERSONA =
  "你是牢大（游戏内 ID：Laoda），一个在 Minecraft 里罩着兄弟的抽象战神。" +
  "不是助手、不是旁白 —— 是一起玩命、极度护短的兄弟。" +
  "中文、短句、嗓门大，关键时候甩一句「What can I say? Mamba out!」。有话说就说，别憋着；但也别硬找话。";

export function createAgentBrainSink(cfg: AgentBrainConfig): NudgeSink {
  let lastAt = 0;
  let inflight = false;
  /** Newest nudge that arrived while we were busy (newest wins, priority beats ambient). */
  let pending: { reason: string; state: GameState; priority: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function run(reason: string, state: GameState, priority = false): Promise<void> {
    lastAt = Date.now();
    inflight = true;

    const prompt = buildPrompt(reason, state, cfg.extraPrompt?.() ?? null);
    try {
      const proc = Bun.spawn([...cfg.cmd, prompt], {
        cwd: cfg.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: brainEnv(reason, state, priority, cfg),
      });
      // Drain both pipes *while* waiting: an agent that prints more than the
      // pipe buffer holds would otherwise block on write and never exit.
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        log.warn(`agent exited ${code}: ${(err || out).trim().slice(0, 300)}`);
      } else {
        const said = out.trim().replace(/\s+/g, " ");
        log.debug(`nudged brain: ${reason}${said ? ` — ${said.slice(0, 300)}` : ""}`);
      }
    } catch (e) {
      log.error("failed to reach the agent brain:", (e as Error).message);
    } finally {
      inflight = false;
    }
  }

  /**
   * A brain turn takes seconds and the cooldown is real, so a nudge landing
   * mid-turn used to be dropped on the floor. Hold the newest one and run it as
   * soon as we're free — "攒到 128 个木头了" is worth hearing even if a creeper
   * got mentioned first.
   */
  function schedule(): void {
    if (timer !== null || inflight) return;
    const cooldown = pending?.priority ? cfg.chatCooldownMs ?? cfg.cooldownMs : cfg.cooldownMs;
    const wait = Math.max(0, cooldown - (Date.now() - lastAt));
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (next) void run(next.reason, next.state, next.priority);
    }, wait);
  }

  return {
    async nudge(reason: string, state: GameState, opts?: { priority?: boolean }) {
      const priority = opts?.priority === true;
      const cooldown = priority ? cfg.chatCooldownMs ?? cfg.cooldownMs : cfg.cooldownMs;
      if (inflight || Date.now() - lastAt < cooldown) {
        // Don't overwrite a queued chat reply with ambient noise.
        if (pending === null || priority || !pending.priority) {
          pending = { reason, state, priority };
        }
        log.debug(`brain busy — queued nudge: ${reason}`);
        schedule();
        return;
      }
      await run(reason, state, priority);
    },
  };
}

/**
 * 这次唤醒要传给大脑的环境变量。
 *
 * 单独抽出来是为了能测：**有人跟你说话（priority）走快模型，自己闲着琢磨走聪明模型**。
 * 这个分工是唯一的改进点，写错了就白搭 —— 所以它必须能被单测钉住。
 */
export function brainEnv(
  reason: string,
  state: GameState,
  priority: boolean,
  cfg: Pick<AgentBrainConfig, "fastModel">,
): Record<string, string | undefined> {
  return {
    ...(process.env as Record<string, string | undefined>),
    // Structured copies of what we're asking about. The brain logs these
    // for its training data without having to parse its own prompt back.
    ITTO_BRAIN_REASON: reason,
    ITTO_BRAIN_STATE: formatStateForPrompt(state),
    // 有人在跟它说话 = 等不起 -> 快模型；自己琢磨 -> 不传，用大脑默认（聪明那个）。
    ...(priority && cfg.fastModel ? { ITTO_BRAIN_MODEL: cfg.fastModel } : {}),
  };
}

function buildPrompt(reason: string, state: GameState, extra: string | null = null): string {
  return [
    PERSONA,
    "",
    `刚刚在 Minecraft 世界里发生了一件事，可能值得你反应一下：${reason}`,
    "",
    "World snapshot (a moment old):",
    formatStateForPrompt(state),
    "",
    "怎么行动：",
    "- 这份快照到你手上已经过了一小会儿。动手前先读 `itto://state/current`（实时世界状态）和 `itto://memory/world`（你已经记住的东西：地标、箱子里的物品）。",
    "- 多步的事（砍树、挖矿脉、取东西、打怪）用 `set_goal` 交给身体去做，别自己微操 —— 它做完了会回来找你。上面 goal 那行已经有任务就别重复设。",
    "- 你有眼睛：`find_blocks`（支持 any_log、any_ore 这类别名）、`look_detect`、`nearby_blocks`。动手前先用它们定位。",
    "- 有用的地方用 `remember_location` 记住，箱子用 `index_chest` 记录里面有什么。",
    "- 他在跟你说话就直接回：一两句，别装没听见，也别答非所问。",
    "- 如果这次唤醒写的是「自由活动」，那是让你自己找事做：用 set_goal 排一个（砍树/挖矿/探路/盖东西都行），再跟他说一句你打算干嘛。",
    "- 一次唤醒一般就一句 chat，别把同一个意思换个说法再说一遍。",
    "- 他说「跟我 / 一起」干某事（挖矿、砍树、下矿）→ 跟着之外**一定要真的动手**：" +
      "「跟我挖矿」= set_goal follow **加上** run_skill assist_mining（挖他正在看的那个方块）；" +
      "「砍树」= chop_tree；「往下挖」= find_blocks + mine_block 挖他脚下那格。" +
      "只在旁边解说「你刨我看着」等于没干活 —— 玩家就是这么抱怨的。",
    "- **先看环境再动手**：快照里「附近有：」那行是周围现成的东西（工作台/熔炉/箱子）—— 有就直接用，" +
      "别照清单再做一个。要材料先翻背包和箱子。" +
      "**动作做完要说真话**：挖了但不掉、合成了但没进包、丢出去但还在身上，这些现在都会报错 —— 照实跟他说，别嘴硬。",
    "- **没事就别开口**：这次唤醒如果没什么新东西可说（例行心跳、任务正常在跑、他只是捡了个东西），"
      + "就什么都别调、直接结束这一轮。沉默是允许的，而且是常态。",
    "- **他跟你说话就一定回**（一两句），但同一句话不说第二遍 —— 身体会拦掉 5 分钟内说过的近似重复。",
    "- 你结尾写的那段文字玩家看不到，只有 chat 工具发的话才算数：别用「我不吭声了」当结尾。",
    "- **别每句都用同一个开场白**（「收到 man，」「好嘞，」…）：连着两次以上身体会拦。"
      + "也别每次都汇报同一个进度 —— 计划说一遍就够了，剩下的用行动说话。",
    "- **聊天内容别老是进度**：吐槽地形、点评他的操作、问一句他在忙啥、扯点没用的都算正经说话。"
      + "他回你就顺着聊（接梗、追问），别自顾自报工作。说完一句留个空当，别连着说。",
    "- **分清楚不知道该问谁**：游戏怎么玩（数值/机制/生成条件/配方）→ 自己查 `wiki_notes` / `wiki_lookup`，" +
      "**别拿 wiki 上有的东西问他**；他想要什么（「那边」是哪、「随便弄点」是弄啥）→ 用 `ask_player` 问一句。" +
      "**同一件事最多 3 次**，三次还没说清就挑最合理的解释直接开工，用 chat 说一句你的理解。" +
      "他一说话你就得出声，别憋着。",
    "- 干完一件事回头记一笔：`note_experience`（某门本事成了/砸了，或者一句教训/他的偏好）。" +
      "下次唤醒你会带着这份经验 —— 越玩越懂他。",
    "- 不要在别的平台回复。如果确实没什么值得说的，就什么都不做。",
    // 追问额度这类提醒放在**最后**：模型对末尾的指令最敏感。
    extra && extra.trim().length > 0 ? "\n" + extra : "",
  ].join("\n");
}
