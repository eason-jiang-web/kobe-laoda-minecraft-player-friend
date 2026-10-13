import type { BotControl, BotGoal, BotIntent, GoalStatus } from "@itto/shared";
import { logger } from "../util/logger.js";

const log = logger("goal");

/** How many skill rounds a verified goal may burn before it admits defeat. */
const MAX_ROUNDS = 6;
/** How long the player gets to pick dropped items up before we call it done anyway. */
const PICKUP_WAIT_MS = 30_000;

/**
 * 这些东西在玩家眼里是**一回事**。
 *
 * 没有这一层的话，「收集 20 个石头」永远完不成 —— 挖石头掉的是**圆石**，
 * 目标里写 stone，背包里就永远数不到（实测就是这样卡的）。
 * 玩家不会卡在这儿：他说"石头"的时候，圆石当然算数。
 */
const SAME_AS: Record<string, string[]> = {
  stone: ["stone", "cobblestone", "cobbled_deepslate", "deepslate"],
  cobblestone: ["cobblestone", "cobbled_deepslate"],
  log: ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"],
  planks: ["oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "pale_oak_planks", "crimson_planks", "warped_planks"],
};

/** 这个目标物品，背包里哪些东西算数。 */
export function namesFor(item: string): string[] {
  return SAME_AS[item] ?? [item];
}

/** 数背包（**包含等价物**）—— "收集石头"时圆石也算。 */
function countIn(inventory: Array<{ name: string; count: number }>, item: string): number {
  const want = new Set(namesFor(item));
  return inventory.filter((i) => want.has(i.name)).reduce((n, i) => n + i.count, 0);
}

/** 只要名字对得上的（交付用 —— 丢东西必须丢对名字）。 */
function countExact(inventory: Array<{ name: string; count: number }>, item: string): number {
  return inventory.filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);
}

/**
 * 挖这个方块会掉什么（名字不一样的那几种）。
 * 这是最基础的常识：**圆石来自挖石头**，燧石来自挖砂砾。
 */
const BLOCK_TO_DROP: Record<string, string> = {
  cobblestone: "stone",
  cobbled_deepslate: "deepslate",
  flint: "gravel",
  clay_ball: "clay",
  snowball: "snow_block",
};

/** 物品本身就是个方块：挖它就行。 */
const DIGGABLE = new Set([
  "stone", "deepslate", "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium",
  "sand", "red_sand", "sandstone", "gravel", "clay", "snow_block", "snow", "ice", "packed_ice", "blue_ice",
  "obsidian", "netherrack", "soul_sand", "soul_soil", "end_stone", "basalt", "blackstone", "tuff",
  "andesite", "diorite", "granite", "calcite", "terracotta", "glowstone", "magma_block", "prismarine",
  "mossy_cobblestone", "cobblestone", "nether_quartz_ore", "amethyst_block", "budding_amethyst",
]);

/**
 * 这个物品该去世界里怎么弄到。
 *
 * 原来只有「木头 / 矿石 / 几颗宝石」三类，于是「刨 8 个石头做石镐」直接死在这儿：
 * 圆石不在表里 → 「不知道用什么办法弄到 cobblestone」。可这是最基础的常识 ——
 * 玩家不会卡在这儿，代码也不该。
 */
export function gatherSkillFor(item: string): { name: string; args?: Record<string, unknown> } | null {
  if (/(_log|_wood|_stem|_hyphae)$/.test(item)) return { name: "chop_tree" };
  if (/_ore$/.test(item)) return { name: "mine_vein", args: { ore: item } };
  if (item.startsWith("raw_")) return { name: "mine_vein", args: { ore: item.slice(4) + "_ore" } };
  if (["diamond", "emerald", "lapis_lazuli", "redstone", "coal", "quartz"].includes(item)) {
    return { name: "mine_vein", args: { ore: item + "_ore" } };
  }
  // 挖方块掉的东西：圆石 ← 石头、燧石 ← 砂砾
  const source = BLOCK_TO_DROP[item];
  if (source) return { name: "mine_vein", args: { ore: source } };
  // 它自己就是个方块：挖它
  if (DIGGABLE.has(item)) return { name: "mine_vein", args: { ore: item } };
  return null;
}

/**
 * 两个目标是不是同一件事。
 *
 * 为什么要判：实测两分钟里 set_goal 被调了 41 次（全是 follow），每次都会
 * cancel 掉上一个 —— 它永远停在"刚开工"，从来没完工过（那两分钟 0 次任务结算），
 * 玩家看到的就是「不干活」。
 */
export function sameIntent(a: BotIntent, b: BotIntent): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "skill":
      return b.kind === "skill" && a.name === b.name;
    case "collect":
      // 数量也算 —— 「砍 8 个」跟「砍 64 个」不是一件事
      return b.kind === "collect" && a.item === b.item && a.count === b.count;
    case "deliver":
      return b.kind === "deliver" && JSON.stringify(a.items) === JSON.stringify(b.items);
    case "say":
      return b.kind === "say" && a.text === b.text;
    // follow / stop：同一种就是同一件事
    default:
      return true;
  }
}

export interface GoalRunnerDeps {
  control: BotControl;
  /** Run a skill by name (wired to skills/index.ts runSkillByName). */
  runSkill(name: string, args?: Record<string, unknown>): Promise<string>;
  suspendFollow(): void;
  resumeFollow(): void;
  /** Fired when a goal finishes (done/failed) so the slow loop can nudge the brain. */
  onComplete(goal: BotGoal): void;
}

/**
 * Turns the brain's `BotIntent` into a real, multi-tick pursuit. The brain sets
 * a goal (via set_goal), the runner advances it ONE non-blocking step per slow-
 * loop tick, and reports completion back so the brain can react. This is what
 * lets one nudge kick off "go chop a tree" and hear "done" when it finishes.
 *
 * Reflexes stay in the fast loop; long thinking stays in the brain. This is the
 * thin executor in between.
 */
export class GoalRunner {
  private current: BotGoal | null = null;
  private queue: BotGoal[] = [];
  /** Most recently finished goal — for pollers (voice bridge) to read. */
  private lastFinished: BotGoal | null = null;
  /** True while a skill/say is awaiting — stops us re-launching it every tick. */
  private inflight = false;

  constructor(private readonly deps: GoalRunnerDeps) {}

  setGoal(intent: BotIntent, label: string): BotGoal {
    // 同一件事已经在跑：**别推倒重来**（不然它永远完不成，看起来就是"不干活"）
    const cur = this.current;
    if (cur && cur.status === "active" && sameIntent(cur.intent, intent)) return cur;
    this.cancel();
    this.current = this.make(intent, label);
    return this.current;
  }

  enqueue(intent: BotIntent, label: string): BotGoal {
    const goal = this.make(intent, label);
    if (!this.current) this.current = goal;
    else this.queue.push(goal);
    return goal;
  }

  cancel(): void {
    if (this.current?.status === "active") {
      this.current.status = "cancelled";
      this.current.updatedAt = Date.now();
      this.deps.control.stop();
      this.deps.resumeFollow();
    }
    this.current = null;
    this.queue = [];
    this.inflight = false;
  }

  currentGoal(): BotGoal | null {
    return this.current;
  }

  /** The last goal that finished (done/failed). Lingers for state pollers. */
  lastGoalFinished(): BotGoal | null {
    return this.lastFinished;
  }

  /** Advance the current goal one step. Called every slow-loop tick. */
  tick(): void {
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) return;
      this.current = next;
    }
    const goal = this.current;
    if (goal.status !== "active") return;
    const state = this.deps.control.getState();

    // Verified goals fall through even while a step is running, so they can
    // notice "the count is already reached" mid-round. One-shot skills don't
    // need that, and re-entering them would double-run the skill.
    if (this.inflight && goal.intent.kind !== "collect" && goal.intent.kind !== "deliver") return;

    switch (goal.intent.kind) {
      case "say": {
        this.inflight = true;
        const { text } = goal.intent;
        void this.deps.control
          .chat(text)
          .then(() => this.finish(goal, "done"))
          .catch((e) => this.finish(goal, "failed", (e as Error).message));
        break;
      }
      case "skill": {
        this.inflight = true;
        this.deps.suspendFollow();
        const { name, args } = goal.intent;
        void this.deps
          .runSkill(name, args)
          .then((res) => {
            goal.progress = res;
            this.finish(goal, "done");
          })
          .catch((e) => this.finish(goal, "failed", (e as Error).message))
          .finally(() => this.deps.resumeFollow());
        break;
      }
      case "follow": {
        this.deps.resumeFollow();
        goal.progress = "following";
        this.finish(goal, "done");
        break;
      }
      case "stop": {
        this.deps.control.stop();
        this.deps.resumeFollow();
        this.finish(goal, "done");
        break;
      }

      // ── Verified goals ────────────────────────────────────────────────
      // These do NOT finish when a skill returns. They finish when the
      // OUTCOME is true, checked against live state every tick. That is the
      // difference between "I swung the axe" and "you have 32 logs".

      case "collect": {
        const { item, count } = goal.intent;
        const have = countIn(state.inventory, item);

        if (have >= count) {
          goal.progress = `${have}/${count} ${item}`;
          this.finish(goal, "done");
          break;
        }

        // A gather round is already running — let it finish, don't stack them.
        if (this.inflight) break;

        const rounds = goal.rounds ?? 0;
        if (rounds >= MAX_ROUNDS) {
          goal.progress = `只弄到 ${have}/${count} ${item}`;
          this.finish(goal, "failed", `弄不到更多了：${have}/${count} ${item}`);
          break;
        }

        const tool = gatherSkillFor(item);
        if (!tool) {
          this.finish(
            goal,
            "failed",
            "不知道去哪弄 " + item + " —— 它多半得**合成**（craft_item）或者从箱子里拿（fetch_item），" +
              "也可能是这个世界里没有。换个说法或者换个目标试试。",
          );
          break;
        }

        goal.rounds = rounds + 1;
        goal.progress = `${have}/${count} ${item}（第 ${goal.rounds} 轮）`;
        this.inflight = true;
        this.deps.suspendFollow();
        void this.deps
          .runSkill(tool.name, tool.args)
          .then((res) => {
            goal.progress = `${countIn(this.deps.control.getState().inventory, item)}/${count} ${item} — ${res}`;
          })
          .catch((e) => {
            goal.error = (e as Error).message;
          })
          .finally(() => {
            // NOT finished: the next tick re-counts the inventory and decides.
            this.inflight = false;
          });
        break;
      }

      case "deliver": {
        const { items } = goal.intent;

        if (!goal.droppedAt) {
          // 交付按**名字**算（丢东西必须丢对名字），但报错要说清「你有多少 / 要多少」——
          // 原来只说「背包里不够：工作台×1、橡木原木×12」，看着像两样都没有，
          // 而它当时手上正拿着工作台（实测把用户看糊涂了）。
          const missing = items
            .map((it) => ({ ...it, have: countExact(state.inventory, it.name) }))
            .filter((it) => it.have < it.count);
          if (missing.length > 0) {
            const detail = missing
              .map((m) => {
                const loose = countIn(state.inventory, m.name) - m.have;
                return (
                  m.name + " " + m.have + "/" + m.count +
                  (loose > 0 ? "（等价物还有 " + loose + " 个，但丢东西得按名字丢）" : "")
                );
              })
              .join("、");
            this.finish(goal, "failed", "背包里不够：" + detail + "（先 collect 或者去箱子里取）");
            break;
          }

          if (this.inflight) break;
          this.inflight = true;
          this.deps.suspendFollow();
          void (async () => {
            const player = this.deps.control.getState().player?.pos;
            if (player) await this.deps.control.moveTo(player, { range: 2 });
            for (const it of items) await this.deps.control.dropItem(it.name, it.count);
            goal.droppedAt = Date.now();
            goal.progress = "丢在你脚边了，等你捡";
          })()
            .catch((e) => this.finish(goal, "failed", (e as Error).message))
            .finally(() => {
              this.inflight = false;
            });
          break;
        }

        // Verification: the dropped item entities are gone -> he picked them up.
        const leftovers = this.deps.control.findEntities(["item"], 6).length;
        const waited = Date.now() - goal.droppedAt;
        if (leftovers === 0) {
          goal.progress = "他收下了";
          this.finish(goal, "done");
        } else if (waited > PICKUP_WAIT_MS) {
          goal.progress = "东西丢在他脚边了（还没见他捡）";
          this.finish(goal, "done");
        }
        break;
      }
    }
  }

  private make(intent: BotIntent, label: string): BotGoal {
    const now = Date.now();
    return { id: crypto.randomUUID(), intent, label, status: "active", createdAt: now, updatedAt: now };
  }

  private finish(goal: BotGoal, status: GoalStatus, error?: string): void {
    goal.status = status;
    goal.updatedAt = Date.now();
    if (error) goal.error = error;
    this.lastFinished = goal;
    this.inflight = false;
    log.debug(`goal "${goal.label}" → ${status}${error ? ": " + error : ""}`);

    // Only nudge the brain for the things worth reacting to: a skill that
    // finished/failed (the autonomy loop), or any failure. Trivial say/follow/
    // stop successes don't re-poke the brain (avoids feedback loops).
    // Anything with real work behind it gets reported back to the brain —
    // including "the task you gave me is finished, give me the next one".
    const trivial =
      goal.intent.kind === "say" || goal.intent.kind === "follow" || goal.intent.kind === "stop";
    if (!trivial) {
      this.deps.onComplete(goal);
    }
    if (this.current?.id === goal.id) this.current = null;
  }
}
