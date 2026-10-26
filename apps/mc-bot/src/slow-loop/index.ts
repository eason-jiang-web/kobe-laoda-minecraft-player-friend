import type { BotGoal, GameState } from "@itto/shared";
import { formatStateForPrompt } from "@itto/shared";
import type { BotController } from "../bot/controller.js";
import type { Config } from "../config.js";
import type { WorldMemory } from "../memory/store.js";
import type { GoalRunner } from "./goal-runner.js";
import {
  createTriggers,
  DEFAULT_TRIGGER_COOLDOWN_MS,
  MEMORY_TRIGGERS,
  triggerReady,
  VibeCheck,
  HeartbeatCheck,
  type Trigger,
} from "./triggers.js";
import { MilestoneTracker, parseMilestones } from "./milestones.js";
import { memeHint, rollMeme } from "./meme.js";
import {
  canMine,
  guessPlayerActivity,
  guideBriefing,
  HABIT,
  isValuableOre,
  needForOre,
  oreValue,
  tierName,
  progressBriefing,
  valueReport,
  type MineVerdict,
  type NeedLine,
  type NotableBlock,
  type Vec3Lit,
} from "@itto/shared";
import { logger } from "../util/logger.js";

const log = logger("slow-loop");

/**
 * A "nudge" is the slow loop telling Claude (via Hermes) that something might
 * be worth a reaction. Hermes ultimately decides whether to speak/act — we
 * just surface opportunities. The actual transport to Hermes is TBD (MCP
 * notification / sampling request / webhook), so we abstract it.
 */
export interface NudgeOpts {
  /** A human is talking to you right now — cut the queue, short cooldown. */
  priority?: boolean;
}

export interface NudgeSink {
  nudge(reason: string, state: GameState, opts?: NudgeOpts): void | Promise<void>;
}

/** Default sink: just logs. Swap for the Hermes bridge once wired. */
export const consoleNudgeSink: NudgeSink = {
  nudge(reason, state) {
    log.info(`NUDGE [${reason}]\n${formatStateForPrompt(state)}`);
  },
};

/**
 * The slow loop. Runs every SLOW_LOOP_INTERVAL_MS (~4s) AND can be poked on
 * events. It does NOT call the LLM directly — Hermes owns the model. It runs
 * cheap trigger predicates and, when something fires, surfaces compact state
 * to Hermes via the NudgeSink.
 */
export class SlowLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: GameState | null = null;
  private readonly vibe = new VibeCheck();
  private readonly heartbeat: HeartbeatCheck;
  /** Identity-aware: "the player said my name" needs to know the bot's name. */
  private readonly triggers: Trigger[];
  /** "You've got 128 logs now" — progress worth telling the player about. */
  private readonly milestones: MilestoneTracker;
  private lastNudgeAt = 0;
  /**
   * 每个触发器上次响的时间 —— 触发器的冷却靠它。
   * 没有它的话，玩家砍树时每捡一个木头就叫醒大脑一次（实测 2 分钟叫了 24 次，
   * 每次都把同一个进度换个说法再报一遍）。
   */
  private readonly lastFired = new Map<string, number>();
  /** 上次采样"他在干嘛"的时间（学他的动作，30 秒一次就够）。 */
  private lastActivityAt = 0;
  /** A goal that just finished, waiting to be surfaced to the brain once. */
  private lastCompleted: BotGoal | null = null;
  /** 上次扫矿的时间（机会主义采矿的节流）。 */
  private oreWatchAt = 0;
  /** 已经点评过的矿：坐标 -> 时间，别对着同一块念叨。 */
  private readonly oreSeen = new Map<string, number>();

  constructor(
    private readonly controller: BotController,
    private readonly cfg: Config,
    private readonly sink: NudgeSink,
    private readonly runner: GoalRunner,
    private readonly memory: WorldMemory,
  ) {
    this.heartbeat = new HeartbeatCheck(cfg.tuning.heartbeatMs);
    this.triggers = createTriggers({
      botUsername: cfg.mc.username,
      wakeWords: cfg.mc.wakeWords,
      replyToAll: cfg.mc.chatReplyAll,
    });
    this.milestones = new MilestoneTracker(parseMilestones(cfg.tuning.reportItems));
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.cfg.tuning.slowLoopIntervalMs);
    log.info(`running every ${this.cfg.tuning.slowLoopIntervalMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Call this on discrete events (chat received) to react faster than the tick. */
  poke(): void {
    this.tick();
  }

  /** The goal runner calls this when a goal finishes — surfaced next tick. */
  notifyGoalComplete(goal: BotGoal): void {
    this.lastCompleted = goal;
  }

  /**
   * 扫一眼附近有没有值钱的矿。**节流 + 去过重**，不然对着同一块矿每 4 秒念叨一次。
   */
  private watchOres(state: GameState): void {
    const now = Date.now();
    if (now - this.oreWatchAt < ORE_SCAN_EVERY_MS) return;
    this.oreWatchAt = now;
    void this.scanOres(state);
  }

  private async scanOres(state: GameState): Promise<void> {
    let notable: NotableBlock[];
    try {
      notable = await this.controller.nearbyNotable(ORE_SCAN_RADIUS);
    } catch {
      return;
    }
    const ores = notable.filter((b) => b.category === "ore" && isValuableOre(b.name));
    if (ores.length === 0) return;

    const now = Date.now();
    for (const [key, at] of this.oreSeen) {
      if (now - at > ORE_MEMO_MS) this.oreSeen.delete(key);
    }

    const ore = ores
      .filter((b) => !this.oreSeen.has(oreKey(b.pos)))
      .sort((a, b) => oreValue(b.name) - oreValue(a.name) || a.distance - b.distance)[0];
    if (!ore) return;
    this.oreSeen.set(oreKey(ore.pos), now);

    const verdict = canMine(state.inventory, ore.name);
    const need = needForOre(state, ore.name);
    log.debug("ore spotted: " + ore.name + " " + ore.distance + "b, canMine=" + verdict.can);
    void this.sink.nudge(oreReason(ore, verdict, need), state, { priority: false });
  }

  /**
   * The "nothing is happening, go do something" prompt. See buildAutoplayReason.
   */
  /** 上一轮闲下来是干活还是陪聊 —— 两种轮流来，别永远只知道干活。 */
  private autoplayMood: AutoplayMood = "work";

  /** 采样他在干嘛（节流 30 秒），记进画像。 */
  private sampleActivity(state: GameState): void {
    const now = Date.now();
    if (now - this.lastActivityAt < 30_000) return;
    this.lastActivityAt = now;
    const act = guessPlayerActivity(state);
    if (act.kind === "unknown") return;
    this.memory.bumpHabit(HABIT.activity(act.kind));
  }

  private autoplayReason(state: GameState): string {
    this.autoplayMood = nextAutoplayMood(this.autoplayMood, state);
    return this.autoplayMood === "chat"
      ? buildChatMoodReason(state, this.memory)
      : buildAutoplayReason(state, this.memory);
  }

  private tick(): void {
    // advance any in-flight goal first, so its state shows in this snapshot
    this.runner.tick();

    const state = this.controller.getState();
    let reason: string | null = null;
    let priority = false;

    // #quiet mutes the social layer, not the reflexes: danger (the triggers
    // below) and anything the player says still get through.
    const quiet = this.controller.isMuted();

    // goal completion takes priority — it's the autonomy loop closing.
    if (this.lastCompleted) {
      const g = this.lastCompleted;
      this.lastCompleted = null;
      const outcome =
        g.status === "done" ? "完成了" : g.status === "failed" ? "没做成" : g.status;
      reason =
        `任务结算：「${g.label}」${outcome}` +
        (g.error ? ` —— ${g.error}` : g.progress ? ` —— ${g.progress}` : "") +
        "。跟他说一声结果，然后你就空闲了（他会接着给你新任务，或者你可以自己找活干）。";
    }
    // Progress beats ambient triggers: good news is worth saying.
    if (!reason && !quiet) reason = this.milestones.check(state);

    // 机会主义采矿：路过值钱的矿就先判断（挖得动吗 / 还缺吗），剩下交给大脑。
    if (!reason && !quiet) this.watchOres(state);

    // 学他的动作：每 30 秒看一眼他在干嘛，记进画像。
    // 攒下来的"常干挖矿/常干砍树"会进大脑的提示词 —— 闲下来时它会偏向你爱干的活。
    this.sampleActivity(state);

    const now = Date.now();
    if (!reason) {
      for (const t of this.triggers) {
        // 冷却没过就**连 check 都不调**：这个触发器的 check 会把动作取走，
        // 不调它，动作就攒着，下次一起说（"他刚刚：捡起了 A；捡起了 B"）。
        if (!triggerReady(t, this.lastFired, now)) continue;
        const r = t.check(state, this.prev);
        if (r) {
          reason = r;
          priority = t.priority === true;
          this.lastFired.set(t.name, now);
          break;
        }
      }
    }
    if (!reason && !quiet) {
      for (const t of MEMORY_TRIGGERS) {
        if (!triggerReady(t, this.lastFired, now)) continue;
        reason = t.check(state, this.prev, this.memory);
        if (reason) {
          this.lastFired.set(t.name, now);
          break;
        }
      }
    }
    if (!reason && !quiet && this.vibe.due())
      // 这是"纯聊天"的常驻机会 —— 所以明确写「别报进度」。
      // 不写的话它每次都拿进度来交差（实测 24 句里 18 句是同一个进度换个说法）。
      reason =
        "vibe check：看一眼周围 —— 有没有什么值得**跟他说一句**的？" +
        "风景、地形、他在干嘛、你自己在琢磨什么、想吐槽什么都行。" +
        "**别报进度、别列计划**（那个刚说过了）。有一句就说，没有就别开口。";
    if (!reason && this.heartbeat.due()) {
      // Autoplay: nothing to react to, nobody talking, no goal running. That's
      // not "stay quiet" — that's "go play the game yourself". #stay cancels it.
      const idle = this.runner.currentGoal() === null;
      const guide = this.controller.isGuide();
      const mayRoam = this.cfg.tuning.autoplay && idle && !this.controller.isHoldPosition();
      if (shouldHeartbeat({ quiet, guide, idle })) {
        reason = guide
          ? // 向导模式：接管心跳 —— 主动看一眼他卡在哪，该提示就提示
            "向导模式的心跳：看一眼他现在的进度，该提示下一步就提示；他正忙着/正爽着就别打断。\n" +
            guideBriefing(state) +
            (mayRoam ? "\n（他要是暂时不想推主线，你也可以自己找点活干，别光站着。）" : "")
          : mayRoam
            ? this.autoplayReason(state)
            : "heartbeat：随便看一眼 —— 有想说的就说（进度、吐槽、发现都行），实在没有就不说";
      }
    }

    this.prev = state;
    if (!reason) return;

    // Global rate limit so we never spam the brain/the player. Chat cuts the line:
    // a reply that lands ten seconds after you asked isn't a reply.
    const limit = priority ? 800 : 2500;
    if (Date.now() - this.lastNudgeAt < limit) return;
    this.lastNudgeAt = Date.now();

    // 牢大's passive skill: the meme rolls its own dice, the brain gets to
    // phrase (or skip) it. See slow-loop/meme.ts for the card's odds.
    const roll = rollMeme(state, reason);
    const nudgeReason = roll ? reason + "\n" + memeHint(roll) : reason;

    void this.sink.nudge(nudgeReason, state, { priority });
  }
}

/**
 * The "nothing is happening, go do something" prompt. This is what turns a
 * reactive pet into something that actually plays the game: it carries the
 * current inventory (so the choice can be sensible) and points at set_goal,
 * which hands the work to the body's background goal runner.
 */
/** 只要这两个方法，WorldMemory 天然满足（结构化兼容）。 */
export interface MemoryDigestSource {
  recentNotes(limit?: number): Array<{ text: string }>;
  recallLocations(filter?: { limit?: number }): Array<{
    name: string;
    pos: { x: number; y: number; z: number };
  }>;
}

/**
 * "你记得的事" —— 让记忆**真的出现在提示里**，而不是留在数据库里等它自己去查。
 * 只在"自己找活干"这个做计划的时刻带上，免得每 45 秒重复同一段。
 */
/**
 * 心跳该不该叫醒大脑。
 *
 * 三种情况：
 *   · #quiet 闭嘴模式   → 不叫
 *   · 向导模式          → 叫（这个心跳是刻意的：主动看他卡在哪、提示下一步）
 *   · 闲着没事          → 叫（"自己找点活干"）
 *   · **任务正在跑**    → 不叫 ⭐
 *
 * 最后一条是实测踩出来的：任务在跑的时候每 45 秒叫它一次，它只能说点什么，
 * 于是历史里连着四条「砍树任务还在跑，不吭声了。」—— 完成任务时 goal-runner
 * 自己会来报，中途根本不需要叫。
 */
export function shouldHeartbeat(opts: { quiet: boolean; guide: boolean; idle: boolean }): boolean {
  if (opts.quiet) return false;
  if (opts.guide) return true;
  return opts.idle;
}

function memoryDigest(memory?: MemoryDigestSource): string {
  if (!memory) return "";
  let notes: string[] = [];
  let places: string[] = [];
  try {
    notes = memory.recentNotes(3).map((n) => n.text);
    places = memory
      .recallLocations({ limit: 4 })
      .map((w) => `${w.name}(${Math.round(w.pos.x)}, ${Math.round(w.pos.y)}, ${Math.round(w.pos.z)})`);
  } catch {
    return "";
  }
  const bits: string[] = [];
  if (places.length > 0) bits.push("去过的地方：" + places.join("、"));
  if (notes.length > 0) bits.push("你自己记的笔记：" + notes.join("；"));
  return bits.length > 0 ? "（你记得的事 —— " + bits.join("；") + "）" : "";
}

/** 扫矿节流：太久不扫就漏，太勤就是白烧 CPU。 */
const ORE_SCAN_EVERY_MS = 15_000;
const ORE_SCAN_RADIUS = 20;
/** 同一块矿多久之内不再提（也别让 Map 长太大）。 */
const ORE_MEMO_MS = 10 * 60_000;

function oreKey(pos: Vec3Lit): string {
  return Math.round(pos.x) + "," + Math.round(pos.y) + "," + Math.round(pos.z);
}

/**
 * 路过一块值钱的矿，该怎么跟大脑说 —— 三条路：能挖且缺就挖；不缺就记坐标走人；
 * 挖不动就**记下来**，等有镐子再回来。
 */
export function oreReason(
  ore: { name: string; pos: Vec3Lit; distance: number },
  verdict: MineVerdict,
  need: NeedLine | null,
): string {
  const where = "(" + Math.round(ore.pos.x) + ", " + Math.round(ore.pos.y) + ", " + Math.round(ore.pos.z) + ")";
  const head = "路过一块值钱的矿：" + ore.name + " 在 " + where + "，离我 " + ore.distance + " 格";

  if (!verdict.can) {
    return (
      head + "。" + (verdict.why ?? "挖不动") + "。\n" +
      "→ 用 remember_location 记下来（name 起个短名，kind 填 \"ore\"，note 填 \"" + ore.name + "\"），" +
      "等他有了镐子我再来；顺手跟他说一声「看到个 " + ore.name + " 挖不动，先记着」。"
    );
  }
  if (need?.surplus) {
    return (
      head + "。但你已经 " + need.have + " 个" + need.label + "了，早就够用 —— " +
      "除非他明确想要，不然别绕路，记个坐标就走（remember_location kind:\"ore\"）。"
    );
  }
  const why =
    need && need.needed
      ? "而且" + need.label + "还没到上限（" + need.have + "/" + need.want + "）—— 值得顺手拿"
      : "（已经到上限了，别特意绕路）";
  return (
    head + "。你手上是" + tierName(verdict.have) + "，挖得动，" + why + "。\n" +
    "→ 顺手挖了它（dig_at 到那个坐标），挖到跟他说一声；他要是赶时间就算了。"
  );
}

/**
 * 闲下来的时候，心跳有两种心情，轮流来：
 *
 *   work —— 自己找活干（原来只有这一种）
 *   chat —— **不排活**，就跟他搭话、陪着他
 *
 * 为什么必须有两种：只有 work 的话，它就成了一个"只干活不说话"的打工机器人 ——
 * 你不在的时候它自己玩，你在的时候它汇报进度，聊天这件事根本不在它的选项里。
 */
export type AutoplayMood = "work" | "chat";

/** 他得在附近，聊天才有意义（不在旁边就回去干活）。 */
export function nextAutoplayMood(
  prev: AutoplayMood,
  state: Pick<GameState, "player">,
): AutoplayMood {
  const nearby = state.player?.online === true && (state.player.distance ?? 99) <= 24;
  if (!nearby) return "work";
  return prev === "work" ? "chat" : "work";
}

/** 陪聊那一版的心跳提示词：重点是**别排活、别报进度**。 */
export function buildChatMoodReason(state: GameState, memory?: MemoryDigestSource): string {
  const inv =
    state.inventory.length === 0
      ? "背包是空的"
      : state.inventory
          .slice()
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((i) => `${i.name}×${i.count}`)
          .join("、");
  return [
    "陪他一会儿：没人叫你，你也没有正在进行的任务 —— 这次**不用排活**，就在他旁边待着。",
    "跟他搭句话：他刚才在干嘛、手上这些东西够折腾点什么、你看见什么好玩的、问一句他今天想干啥。"
      + "吐槽地形、点评他的操作、扯个篮球的淡、关心他一句 —— 都行。",
    "**别汇报进度、别列计划、别报数据** —— 那是上一轮的事。这次就是聊天，"
      + "哪怕只说一句没用的废话也比念进度条强。",
    `背包里主要是：${inv}。`,
    "说完就安静跟着他；实在没什么想说的，就什么都不说（这也完全没问题）。",
    memoryDigest(memory),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function buildAutoplayReason(state: GameState, memory?: MemoryDigestSource): string {
  const inv =
    state.inventory.length === 0
      ? "背包是空的"
      : state.inventory
          .slice()
          .sort((a, b) => b.count - a.count)
          .slice(0, 8)
          .map((i) => `${i.name}×${i.count}`)
          .join("、");
  const goal = state.currentGoal ? `（当前任务：${state.currentGoal.label}）` : "";
  return [
    `自由活动${goal}：没人叫你，也没有正在进行的任务 —— 你自己决定干点什么。`,
    // 进度 + 工程评估：让他知道"走到哪一步了""现在材料够盖什么"。
    // 没有这段的时候，自主玩只会说"自己找点事干"，模型就只剩原地转圈或者尬聊。
    progressBriefing(state),
    `背包里主要是：${inv}。`,
    "从上面挑一件**当下合适**的：进度那步优先；工程只在材料够了、而且他也方便的时候提。",
    "决定好就用 set_goal 交给身体去做（它在后台跑，做完会回来找你），然后跟他说一句你打算干嘛。",
    "真的什么都不想干，就安静跟着他，别硬找事。",
    valueReport(state),
    memoryDigest(memory),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
