import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type {
  BlockQuery,
  BotControl,
  EntityInfo,
  GameState,
  LookedAtBlock,
  NotableBlock,
  Vec3Lit,
} from "@itto/shared";
// 值导入（不是 type）：中文名 → id 的归一化，工具入参都要过这一道
import { findRepeat, rememberSaid, repeatedOpener, toItemId, type SaidLine } from "@itto/shared";
import type { Config } from "../config.js";
import { extractGameState } from "../state/extract.js";
import { systemSince } from "../state/system-log.js";
import { classifyTpReply, isOpDenied } from "../util/op-hint.js";
import { checkCommand } from "../server-commands.js";
import { HOSTILE } from "../state/hostiles.js";
import { logger } from "../util/logger.js";

const log = logger("controller");

/**
 * Minecraft 聊天栏一行的硬上限。留 1 个字符给省略号，正好 256。
 */
const MC_CHAT_LIMIT = 256;

const round = (n: number) => Math.round(n * 100) / 100;
const toLit = (v: { x: number; y: number; z: number }): Vec3Lit => ({
  x: round(v.x),
  y: round(v.y),
  z: round(v.z),
});

/** Block names treated as the "any_stone" group. */
const STONE_NAMES = new Set([
  "stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite",
  "diorite", "granite", "tuff", "calcite", "blackstone", "basalt", "netherrack",
]);

/**
 * Concrete BotControl over a live Mineflayer bot. This is the ONE place that
 * touches Mineflayer's action APIs. Skills and MCP tools both go through here,
 * so behavior (and safety) stays consistent.
 */
export class BotController implements BotControl {
  /** Cache of friendly-name → block ids (the registry is static per session). */
  private blockIdCache = new Map<string, number[]>();
  /**
   * Whether the server lets us /tp. null = haven't tried yet. Once we learn it
   * doesn't, we stop trying and just walk — no point spamming a command the
   * server throws away (and no point pretending we arrived).
   */
  private canTeleport: boolean | null = null;
  /** #free: no automatic /tp to the player, however far he goes. */
  private freeRoam = false;
  /** #stop: attack() refuses until something re-arms it. */
  private pacifist = false;
  /** True only for the duration of one attackDirect() swing. */
  private directOrder = false;
  /** Bumped by #stop so an in-flight #attack routine knows it was cancelled. */
  private attackEpoch = 0;
  /** #stay: wait right here — no following, no playing on his own. */
  private holdPosition = false;
  /** #quiet: stop volunteering lines (conversation and danger still get through). */
  private muted = false;
  /** #guide mode: act as a tour guide and nudge him along the main quest. */
  private guide = false;

  constructor(
    private bot: Bot,
    private readonly cfg: Config,
  ) {}

  /**
   * Re-point this controller at a fresh Mineflayer connection after a
   * reconnect. Keeps the same controller instance (already injected into the
   * MCP server) so the brain's session survives the body swapping out.
   */
  setFreeRoam(on: boolean): void {
    this.freeRoam = on;
  }

  isFreeRoam(): boolean {
    return this.freeRoam;
  }

  setPacifist(on: boolean): void {
    this.pacifist = on;
  }

  isPacifist(): boolean {
    return this.pacifist;
  }

  setHoldPosition(on: boolean): void {
    this.holdPosition = on;
  }

  isHoldPosition(): boolean {
    return this.holdPosition;
  }

  setGuide(on: boolean): void {
    this.guide = on;
  }

  isGuide(): boolean {
    return this.guide;
  }

  setMuted(on: boolean): void {
    this.muted = on;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * An explicit "hit THIS one" order (#attack <name>). It is allowed even while
   * holding fire — the player named a target, that's not autonomous fighting —
   * and it does NOT lift the hold: #nonstop is still the only way to re-arm him.
   */
  async attackDirect(entityId: number): Promise<void> {
    this.directOrder = true;
    try {
      await this.attack(entityId);
    } finally {
      this.directOrder = false;
    }
  }

  /** #stop invalidates any #attack routine that's mid-swing. */
  cancelAttackOrders(): void {
    this.attackEpoch++;
  }

  /** An #attack routine remembers this and bails out if it changes. */
  attackOrder(): number {
    return this.attackEpoch;
  }

  rebind(bot: Bot): void {
    this.bot = bot;
    this.blockIdCache.clear();
    // A fresh connection is a fresh world session: the player may have re-opened
    // the LAN world (and lost the op), so forget what we learned about /tp.
    this.canTeleport = null;
  }

  async moveTo(
    target: Vec3Lit,
    opts?: { range?: number; sprint?: boolean; noTeleport?: boolean },
  ): Promise<void> {
    const range = opts?.range ?? 1;
    const here = this.bot.entity.position;
    const dist = here.distanceTo(new Vec3(target.x, target.y, target.z));

    // Long-haul fallback: teleport instead of pathing across the world.
    // Set TELEPORT_FALLBACK_DISTANCE=0 to never use it (no /op needed at all).
    const tpRange = this.cfg.tuning.teleportFallbackDistance;
    const mayTeleport = !opts?.noTeleport && !this.freeRoam;
    if (mayTeleport && tpRange > 0 && dist > tpRange && this.canTeleport !== false) {
      log.debug(`dist ${dist.toFixed(1)} > ${tpRange}, trying teleport`);
      if (await this.tryTeleport(target)) return;

      this.canTeleport = false;
      log.warn(
        "teleport didn't move us — the bot isn't op, so long trips will be walked instead. " +
          "Run '/op " + this.bot.username + "' in game to make them instant, " +
          "or set TELEPORT_FALLBACK_DISTANCE=0 to stop trying.",
      );
    }

    const goal = new goals.GoalNear(target.x, target.y, target.z, range);
    await this.bot.pathfinder.goto(goal);
  }

  /**
   * Fire /tp and then CHECK we actually moved. Without op the server quietly
   * drops the command, and the old version treated that as success — the body
   * believed it had arrived while standing completely still.
   */
  private async tryTeleport(target: Vec3Lit): Promise<boolean> {
    const before = this.bot.entity.position.clone();

    // 已经在目标点上了：没有"位移"可验，但这本来就该算成功 ——
    // 少了这一条，"站在你旁边时喊它过来"会被误报成"没 op"（实测就是这么翻的车）。
    if (before.distanceTo(new Vec3(target.x, target.y, target.z)) <= 1) return true;

    this.bot.chat(`/tp ${this.bot.username} ${target.x} ${target.y} ${target.z}`);
    await new Promise((r) => setTimeout(r, 800));
    return this.bot.entity.position.distanceTo(before) > 1;
  }

  /**
   * 瞬移到某个玩家身边 —— "过来" 的实现。
   *
   * 位置看得见就直接跳到坐标（快，而且能验证真的动了）。
   * **看不见时退回"按名字 tp"**：玩家在别的维度、或者离太远没发过来时，客户端拿不到
   * 坐标，但服务端认识这个名字 —— `/tp @s eason` 照样成立，还能跨维度跟过去。
   * （之前这种情况 #back 会直接说"看不见你在哪"，等于瞬移废了一半。）
   */
  async teleportToPlayer(name?: string): Promise<string> {
    const target = (name ?? this.cfg.mc.ownerUsername).trim();
    const entity = this.bot.players[target]?.entity;
    if (entity) {
      const p = entity.position;
      await this.teleportTo({ x: round(p.x), y: round(p.y), z: round(p.z) });
      return "坐标瞬移到 " + target + "（" + round(p.x) + ", " + round(p.y) + ", " + round(p.z) + "）";
    }

    // 看不见人也别放弃：让服务端按名字把人找出来。
    const sentAt = Date.now();
    this.bot.chat("/tp @s " + target);
    await new Promise((r) => setTimeout(r, 900));
    const reply = systemSince(sentAt)
      .filter((l) => !l.startsWith("<"))
      .join(" | ")
      .trim();

    const verdict = classifyTpReply(reply);
    if (verdict === "denied") {
      throw new Error("服务端不给瞬移权限（游戏里打一次 /op " + this.bot.username + " 就行）");
    }
    if (verdict === "notfound") {
      throw new Error("服务端说找不到 " + target + "（人可能不在这个世界）");
    }
    if (verdict === "ok") return "按名字瞬移：" + reply;
    // 看不懂的回话不冒充成功，原样报回去。
    return reply ? "发了 /tp @s " + target + "，服务器回：" + reply : "发了 /tp @s " + target + "（服务端没吭声）";
  }

  async teleportTo(target: Vec3Lit): Promise<void> {
    if (await this.tryTeleport(target)) {
      // It worked: they may have opped us since the last attempt, so let the
      // automatic long-haul fallback try again too.
      this.canTeleport = true;
      return;
    }
    this.canTeleport = false;
    throw new Error(
      `teleport didn't work — I need server op for this. Run "/op ${this.bot.username}" in game once.`,
    );
  }

  async lookAt(target: Vec3Lit): Promise<void> {
    await this.bot.lookAt(new Vec3(target.x, target.y + 1.6, target.z), true);
  }

  /**
   * 等一个条件成立。
   *
   * 存在的理由：**await 一个 mineflayer 调用不代表世界里真的变了** ——
   * 服务端可以拒绝、包可以丢、手上的工具可能不对，可调用照样"成功"返回。
   * 用户的原话是「真的操作而不是以为在操作」，所以每个动作之后都要回头看一眼。
   */
  private async waitFor(ok: () => boolean, timeoutMs = 700, stepMs = 60): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (ok()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  /** 背包里某个物品一共几个（按 id 数，中文名也能用）。 */
  private countItem(name: string): number {
    const key = toItemId(name);
    return this.bot.inventory
      .items()
      .filter((i) => i.name === key)
      .reduce((n, i) => n + i.count, 0);
  }

  async mineBlock(pos: Vec3Lit): Promise<void> {
    const at = new Vec3(pos.x, pos.y, pos.z);
    const block = this.bot.blockAt(at);
    if (!block) throw new Error("no block at that position");
    const was = block.name;
    await this.bot.dig(block);
    // 挖完回头看一眼：方块真的没了吗（工具不对 / 被拦的时候 dig 也会"成功"返回）
    const gone = await this.waitFor(() => {
      const now = this.bot.blockAt(at);
      return !now || now.name === "air" || now.name !== was;
    });
    if (!gone) throw new Error(`挖了 ${was}，但方块还在原地（工具不对？还是服务端没认）`);
  }

  async placeBlock(pos: Vec3Lit, item: string): Promise<void> {
    const at = new Vec3(pos.x, pos.y, pos.z);
    const ref = this.bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z));
    if (!ref) throw new Error("no reference block to place against");
    await this.equip(item);
    await this.bot.placeBlock(ref, new Vec3(0, 1, 0));
    const placed = await this.waitFor(() => {
      const now = this.bot.blockAt(at);
      return !!now && now.name !== "air";
    });
    if (!placed) throw new Error(`${item} 没放上去（位置被占了？够不着？）`);
  }

  async dropItem(name: string, count?: number): Promise<void> {
    const key = toItemId(name);
    const before = this.countItem(key);
    const item = this.bot.inventory.items().find((i) => i.name === key);
    if (!item) throw new Error(`no ${name} in inventory`);
    const want = count ?? item.count;
    await this.bot.toss(item.type, null, want);
    // 丢完确认背包真的少了 —— 不然就是"以为丢了"
    const gone = await this.waitFor(() => this.countItem(key) <= before - want, 900);
    if (!gone) throw new Error(`${name} 没丢出去（背包里还有 ${this.countItem(key)} 个）`);
  }

  async equip(name: string, destination: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand" = "hand"): Promise<void> {
    const key = toItemId(name);
    const item = this.bot.inventory.items().find((i) => i.name === key);
    if (!item) throw new Error(`no ${name} to equip`);
    await this.bot.equip(item, destination);
  }

  async attack(entityId: number): Promise<void> {
    if (this.pacifist && !this.directOrder) {
      throw new Error("停火中（#stop）—— 想动手就打 #nonstop，或者直接点名 #attack <名字>");
    }
    const entity = this.bot.entities[entityId];
    if (!entity) throw new Error("entity gone");
    await this.bot.attack(entity);
  }

  /**
   * 说话的唯一出口。所有 chat 都走这里，所以在这里兜住 Minecraft 的两个硬限制：
   *   1. 聊天栏一行最多 256 字符 —— 超了服务端直接丢包，表现是"它什么都没说"，
   *      非常难查（#value 的清单、长报告都可能撞上）。
   *   2. 换行会把一句话拆成多个包 —— 中文长句里混进 \n 就变成刷屏。
   */
  async chat(message: string): Promise<void> {
    const clean = message.replace(/\s*\r?\n\s*/g, " ").trim();
    if (clean.length === 0) return;

    // 聊天不说话的地方："/" 开头是**服务器指令**，必须走 runServerCommand（那儿有白名单）。
    // 在这里拦一道是最后一道闸 —— 不然任何绕过工具的调用都能 /fill 拆家。
    if (clean.startsWith("/")) {
      throw new Error("chat() 不出指令 —— 指令走 runServerCommand（有白名单）");
    }
    if (clean.length <= MC_CHAT_LIMIT) {
      this.bot.chat(clean);
      return;
    }
    const cut = clean.slice(0, MC_CHAT_LIMIT - 1) + "…";
    log.warn("chat too long (" + clean.length + " chars), truncated: " + cut.slice(0, 48) + "…");
    this.bot.chat(cut);
  }

  /** 最近说过的话（防复读的刹车，见 shared/repeat.ts）。 */
  private recentSaid: SaidLine[] = [];

  /**
   * 大脑主动说话走这里：5 分钟内说过一模一样的、或者几乎一样的话，就**不发**。
   *
   * 实测被这句话刷屏过：「砍树任务还在跑，不吭声了。」连着四条。
   * 提示词里已经写了别复读，但模型每次都是新进程 —— 只有身体拦得住。
   */
  async chatIfNew(message: string): Promise<{ ok: boolean; why?: string }> {
    const now = Date.now();
    const hit = findRepeat(message, this.recentSaid, now);
    if (hit) {
      const secs = Math.max(1, Math.round((now - hit.at) / 1000));
      return {
        ok: false,
        why:
          "这句你刚说过（" + secs + " 秒前：「" + hit.text + "」）—— 没发出去。" +
          "要么说点**新的**，要么这一次什么都别说（沉默是允许的）。",
      };
    }
    // 字面不同、但开头一模一样的也算复读：实测 24 句里 18 句是「收到 man，…」开头，
    // 正文句句不同，可读起来就是复读机。同一个开头用两次以上就叫停。
    const opener = repeatedOpener(message, this.recentSaid, now);
    if (opener) {
      return {
        ok: false,
        why:
          "你这几句都是「" + opener.text.slice(0, 12) + "…」这个开头 —— 没发出去。" +
          "换个开场白，或者这回干脆别说（沉默是可以的）。",
      };
    }
    await this.chat(message);
    this.recentSaid = rememberSaid(this.recentSaid, message, now);
    return { ok: true };
  }

  /**
   * 开机自检权限：先按玩家要求自己发一次 /op，再用一条 level-2 指令问出**真实**权限。
   *
   * 为什么不拿 /op 的回执当结论：/op 要 level 3，而瞬移（/tp）只要 level 2。
   * 局域网开了作弊的世界里，玩家常常已经有能用的权限、但 /op 照样被拒 ——
   * 拿 /op 回执当结论就会**误报**（明明能瞬移，却在游戏里喊"给我 op"）。
   *
   * 所以：/op 只是"帮你顺手要一下"，真正的判据是 level-2 那条指令的回复。
   */
  async probePermissions(): Promise<{
    canTeleport: boolean;
    /** level-2 指令的回复（判定依据）。 */
    reply: string;
    /** /op 自己的回执（只用来写日志）。 */
    opReply: string;
  }> {
    const readReplies = async (since: number): Promise<string> => {
      await new Promise((r) => setTimeout(r, 900));
      return systemSince(since)
        .filter((l) => !l.startsWith("<"))
        .join(" | ")
        .trim();
    };

    const opSentAt = Date.now();
    this.bot.chat("/op " + this.bot.username);
    const opReply = await readReplies(opSentAt);

    // /time query 要 level 2 —— 正好和 /tp 同档，答上来就说明瞬移能用。
    const probeSentAt = Date.now();
    this.bot.chat("/time query daytime");
    const reply = await readReplies(probeSentAt);

    return { canTeleport: reply.length > 0 && !isOpDenied(reply), reply, opReply };
  }

  /**
   * Run a server command via the chat bar. Two guards: the allow-list decides
   * WHAT may run (see server-commands.ts), and we read the server's reply back
   * so the brain isn't firing blind.
   */
  async runServerCommand(command: string): Promise<string> {
    const verdict = checkCommand(command, this.cfg.mc.allowedCommands);
    if (!verdict.ok) throw new Error(verdict.reason);

    const sentAt = Date.now();
    this.bot.chat("/" + verdict.command);
    await new Promise((r) => setTimeout(r, 600));

    const feedback = systemSince(sentAt).filter((l) => !l.startsWith("<"));
    return feedback.length > 0
      ? `跑了 /${verdict.command}；服务器回：${feedback.join(" | ")}`
      : `跑了 /${verdict.command}（服务器没吭声，一般就是成了）`;
  }

  getState(): GameState {
    return extractGameState(this.bot, this.cfg.mc.ownerUsername);
  }

  stop(): void {
    this.bot.pathfinder.stop();
    this.bot.clearControlStates();
  }

  // ── Perception ───────────────────────────────────────────────────────────

  async findBlocks(query: BlockQuery): Promise<Vec3Lit[]> {
    const ids = this.resolveBlockIds(query.name);
    if (ids.length === 0) return [];
    const found = this.bot.findBlocks({
      matching: ids,
      maxDistance: Math.min(query.maxDistance ?? 32, 64),
      count: query.count ?? 8,
      point: this.bot.entity.position,
    });
    return found.map(toLit);
  }

  async lookingAt(opts?: { player?: string; maxDistance?: number }): Promise<LookedAtBlock | null> {
    const username = opts?.player ?? this.cfg.mc.ownerUsername;
    const ent = this.bot.players[username]?.entity;
    if (!ent) return null;
    const block = this.bot.blockAtEntityCursor(ent, opts?.maxDistance ?? 6);
    if (!block || block.name === "air") return null;
    return { name: block.name, pos: toLit(block.position) };
  }

  async nearbyNotable(maxDistance = 24): Promise<NotableBlock[]> {
    const cats: Array<[string, NotableBlock["category"]]> = [
      ["any_log", "log"],
      ["any_ore", "ore"],
      ["water", "water"],
      ["any_chest", "chest"],
    ];
    const here = this.bot.entity.position;
    const out: NotableBlock[] = [];
    for (const [query, category] of cats) {
      const ids = this.resolveBlockIds(query);
      if (ids.length === 0) continue;
      const found = this.bot.findBlocks({ matching: ids, maxDistance, count: 3, point: here });
      for (const v of found) {
        const b = this.bot.blockAt(v);
        out.push({ name: b?.name ?? query, pos: toLit(v), distance: round(here.distanceTo(v)), category });
      }
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 8);
  }

  playerHeading(player?: string): Vec3Lit | null {
    const username = player ?? this.cfg.mc.ownerUsername;
    const ent = this.bot.players[username]?.entity;
    if (!ent) return null;
    // Minecraft view direction (matches mineflayer's getViewDirection).
    const yaw = ent.yaw;
    const pitch = ent.pitch;
    const cp = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }

  // ── Mid-level action primitives ──────────────────────────────────────────

  /** pathfinder.goto with a hard time cap so a stuck path can't hang a skill. */
  private gotoSafe(goal: Parameters<Bot["pathfinder"]["goto"]>[0], ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(() => {
        this.bot.pathfinder.stop();
        finish();
      }, ms);
      this.bot.pathfinder
        .goto(goal)
        .then(() => {
          clearTimeout(timer);
          finish();
        })
        .catch(() => {
          clearTimeout(timer);
          finish();
        });
    });
  }

  /** 够不够得着这个方块（原版手长大概 4.5）。 */
  private inReach(v: Vec3): boolean {
    return this.bot.entity.position.distanceTo(v) <= 4.5;
  }

  /**
   * 跳一下再试 —— 树上部那几格就是这么拿到的。
   * 玩家砍树不会"够不着就算了"，他会跳。
   */
  private async jumpOnce(): Promise<void> {
    if (!this.bot.entity.onGround) return;
    this.bot.setControlState("jump", true);
    await new Promise((r) => setTimeout(r, 160));
    this.bot.setControlState("jump", false);
    await new Promise((r) => setTimeout(r, 120));
  }

  /**
   * 挖掉一个方块。**够不着会真的想办法**，不再是"悄悄跳过"。
   *
   * 这是"砍树只掉 1 个木头"的根子：树干上部的方块离你 5~7 格，
   * 原来的代码直接 return，调用方还把它算成挖成功了。
   *
   * 三步走（都是玩家会干的事）：走过去 → 跳一下 → 钻进树干里（脚下那格）再挖。
   * 返回 true 只代表**方块真的没了**（会回头确认）。
   */
  async digAt(pos: Vec3Lit): Promise<boolean> {
    const v = new Vec3(pos.x, pos.y, pos.z);
    let block = this.bot.blockAt(v);
    if (!block || block.name === "air") return false;
    const wasName = block.name;

    // 自救阶梯：走过去 → 跳 → 钻进树干 → 挖穿挡路的 → 脱困 → 垫方块上爬
    await this.gotoSafe(new goals.GoalGetToBlock(pos.x, pos.y, pos.z), 8000);
    if (!this.inReach(v)) await this.jumpOnce();
    if (!this.inReach(v)) {
      // 钻进树干/矿脉里：站到它下面那一格，抬头就够得着了
      await this.gotoSafe(new goals.GoalBlock(pos.x, pos.y - 1, pos.z), 4000);
      if (!this.inReach(v)) await this.jumpOnce();
    }
    if (!this.inReach(v)) {
      // 隔着一层石头：直接挖穿（玩家不会绕地球一圈）
      await this.digThrough(v);
      if (!this.inReach(v)) await this.jumpOnce();
    }
    if (!this.inReach(v)) {
      // 路被卡住了：蹦一下 / 挖开身边的方块
      await this.unstuck();
      if (!this.inReach(v)) await this.jumpOnce();
    }
    if (!this.inReach(v)) {
      // 目标在上面且实在够不着：垫方块往上爬（最多垫 2 格，别把方块败光）
      for (let i = 0; i < 2 && !this.inReach(v); i++) {
        if (!(await this.pillarUp())) break;
      }
    }
    if (!this.inReach(v)) {
      log.debug(`digAt: 跳了、挖了、垫了还是够不着 (${pos.x},${pos.y},${pos.z})`);
      return false;
    }

    block = this.bot.blockAt(v);
    if (!block || block.name === "air") return true; // 路上已经掉了
    const tool = this.bot.pathfinder.bestHarvestTool(block);
    if (tool) await this.bot.equip(tool, "hand").catch(() => undefined);
    await this.bot.dig(block);

    // 回头看一眼：真的没了吗（工具不对 / 服务端没认的时候 dig 也会"成功"返回）
    const gone = await this.waitFor(() => {
      const now = this.bot.blockAt(v);
      return !now || now.name === "air" || now.name !== wasName;
    }, 1200);
    if (!gone) log.debug(`digAt: 挖了但还在 (${pos.x},${pos.y},${pos.z})`);
    return gone;
  }

  /** 拿来垫脚的方块（便宜、好挖、管够的那几种）。 */
  private static readonly PILLAR_BLOCKS = [
    "cobblestone", "cobbled_deepslate", "dirt", "netherrack", "stone", "deepslate",
    "andesite", "diorite", "granite", "sandstone", "tuff",
  ];

  /**
   * **垫一格往上爬** —— 树顶实在够不着的时候用（玩家就是这么干的）。
   *
   * 技巧：脚下那格必须是实心的；跳起来的一瞬间往脚下放方块。
   * 返回 true 只代表**真的升上去了**（位置验证，不是"以为垫了"）。
   */
  async pillarUp(): Promise<boolean> {
    const items = this.bot.inventory.items();
    const block =
      items.find((i) => BotController.PILLAR_BLOCKS.includes(i.name)) ??
      items.find((i) => /_planks$/.test(i.name));
    if (!block) return false;

    const feet = this.bot.entity.position;
    const below = this.bot.blockAt(feet.offset(0, -1, 0));
    if (!below || below.boundingBox === "empty") return false; // 脚下是空的，垫不了

    await this.bot.equip(block, "hand").catch(() => undefined);
    const y0 = this.bot.entity.position.y;
    this.bot.setControlState("jump", true);
    await new Promise((r) => setTimeout(r, 110));
    try {
      await this.bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      // 跳的时机不对会放空，下面用"位置有没有变"来判断，不慌
    }
    await new Promise((r) => setTimeout(r, 180));
    this.bot.setControlState("jump", false);

    const up = await this.waitFor(() => this.bot.entity.position.y > y0 + 0.4, 900);
    if (!up) log.debug("pillarUp: 垫了但没上去");
    return up;
  }

  /**
   * **把挡在路上的方块挖掉** —— 目标在墙后面、隔着一层石头的时候。
   *
   * 玩家不会为了够一块石头绕地球一整圈，他会直接挖穿。
   * 从眼睛朝目标做一次射线采样，遇到实心方块就挖，最多挖 2 格（别把山挖穿）。
   * 返回挖掉了几块。
   */
  async digThrough(target: Vec3Lit | Vec3): Promise<number> {
    const t = target instanceof Vec3 ? target : new Vec3(target.x, target.y, target.z);
    const eye = this.bot.entity.position.offset(0, 1.6, 0);
    const dir = t.minus(eye);
    const dist = dir.norm();
    if (!Number.isFinite(dist) || dist < 0.6) return 0;
    const step = dir.scaled(1 / dist);

    let dug = 0;
    for (let d = 0.6; d < dist - 0.5 && dug < 2; d += 0.5) {
      const p = eye.plus(step.scaled(d)).floor();
      const b = this.bot.blockAt(p);
      if (!b || b.boundingBox === "empty") continue; // 空气，继续往前看
      if (b.position.distanceTo(t) < 0.8) break; // 到目标了，别把目标挖了
      const tool = this.bot.pathfinder.bestHarvestTool(b);
      if (tool) await this.bot.equip(tool, "hand").catch(() => undefined);
      try {
        await this.bot.dig(b);
        dug++;
      } catch {
        break;
      }
    }
    if (dug > 0) log.debug("digThrough: 挖穿了 " + dug + " 格挡路的方块");
    return dug;
  }

  /**
   * **卡住了自救**：先蹦一下往前蹭；还不动就把身边挡路的方块挖掉再蹭。
   * 返回 true = 位置真的变了（不是"以为动了"）。
   */
  async unstuck(): Promise<boolean> {
    const before = this.bot.entity.position.clone();
    const moved = () => this.waitFor(() => this.bot.entity.position.distanceTo(before) > 0.6, 450);

    this.bot.setControlState("jump", true);
    this.bot.setControlState("forward", true);
    await new Promise((r) => setTimeout(r, 350));
    this.bot.setControlState("forward", false);
    this.bot.setControlState("jump", false);
    if (await moved()) return true;

    // 还卡着：把四个方向挡路的挖掉（bedrock 挖不动，跳过）
    const feet = this.bot.entity.position.floor();
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const b = this.bot.blockAt(feet.offset(dx, 0, dz));
      if (!b || b.boundingBox === "empty" || b.name === "bedrock") continue;
      try {
        await this.bot.dig(b);
      } catch {
        // 挖不动就换下一个方向
      }
    }
    this.bot.setControlState("forward", true);
    await new Promise((r) => setTimeout(r, 350));
    this.bot.setControlState("forward", false);
    const ok = await moved();
    if (ok) log.debug("unstuck: 挖开之后出来了");
    return ok;
  }

  /** 这个位置亮不亮（方块光 / 天光取大的）。 */
  private lightAt(pos: Vec3): number {
    const b = this.bot.blockAt(pos);
    if (!b) return 15; // 没加载就当亮着，别乱插火把
    const raw = b as unknown as { light?: number; skyLight?: number };
    return Math.max(raw.light ?? 0, raw.skyLight ?? 0);
  }

  /**
   * **太黑了就自己插火把** —— 下矿下到伸手不见五指，它会先点灯再干活。
   *
   * 找脚边一圈"下面是实心、上面是空"的地方放；放完看光照有没有真的上去
   * （没上去就换下一个点，全都不行就返回 false，不假装成功）。
   */
  async ensureLight(): Promise<boolean> {
    const feet = this.bot.entity.position;
    if (this.lightAt(feet) >= 7) return false; // 够亮，不用管

    const torch = this.bot.inventory.items().find((i) => /_?torch$/.test(i.name));
    if (!torch) return false;
    await this.bot.equip(torch, "hand").catch(() => undefined);

    // 脚边四个方向 + 脚下：找能放火把的实心面
    const offsets: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of offsets) {
      const ref = this.bot.blockAt(feet.offset(dx, -1, dz));
      if (!ref || ref.boundingBox === "empty") continue;
      const above = this.bot.blockAt(ref.position.offset(0, 1, 0));
      if (!above || above.boundingBox !== "empty") continue;
      try {
        await this.bot.placeBlock(ref, new Vec3(0, 1, 0));
      } catch {
        continue;
      }
      const lit = await this.waitFor(() => this.lightAt(feet) >= 7, 700);
      if (lit) {
        log.debug("ensureLight: 点亮了 " + Math.round(feet.x) + "," + Math.round(feet.y) + "," + Math.round(feet.z));
        return true;
      }
    }
    return false;
  }

  /** 挖一串方块，只数**真的挖掉的**（够不着的不算，别自欺欺人）。 */
  async mineMany(positions: Vec3Lit[]): Promise<number> {
    let mined = 0;
    for (const p of positions) {
      try {
        if (await this.digAt(p)) mined++;
      } catch (e) {
        log.debug(`mineMany skip (${p.x},${p.y},${p.z}): ${(e as Error).message}`);
      }
      // 挖着挖着天黑了就自己点灯（每 6 格看一次，别每格都找火炬）
      if (mined > 0 && mined % 6 === 0) {
        try {
          await this.ensureLight();
        } catch {
          // 点灯失败不该影响挖矿
        }
      }
    }
    return mined;
  }

  async collectNearbyDrops(opts?: { radius?: number; timeoutMs?: number }): Promise<number> {
    // Entity-based pickup: walk onto tracked item entities so vanilla pickup
    // fires. NOTE: some servers/protocol versions don't surface item entities
    // in bot.entities; for skills that know where they mined, sweepColumns() is
    // the reliable collector. This stays best-effort for loose loot (combat).
    const radius = opts?.radius ?? 8;
    const timeoutMs = opts?.timeoutMs ?? 8000;
    const start = Date.now();
    let collected = 0;
    let lastId = -1;
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      const here = this.bot.entity.position;
      const drop = this.bot.nearestEntity(
        (e) => e.name === "item" && e.position.distanceTo(here) <= radius,
      );
      if (!drop) break;
      if (drop.id === lastId) {
        if (++attempts >= 3) break;
      } else {
        lastId = drop.id;
        attempts = 0;
      }
      await this.gotoSafe(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0), 4000);
      await new Promise((r) => setTimeout(r, 200));
      if (!this.bot.entities[drop.id]) collected++;
    }
    return collected;
  }

  async sweepColumns(positions: Vec3Lit[]): Promise<void> {
    // Walk the X/Z column of each mined block so vanilla auto-pickup grabs the
    // drops (they fall to the ground beneath where the block was). Works even
    // when item entities aren't tracked.
    const seen = new Set<string>();
    for (const p of positions) {
      const x = Math.floor(p.x);
      const z = Math.floor(p.z);
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.gotoSafe(new goals.GoalNearXZ(x, z, 1), 4000);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async craft(itemName: string, count = 1): Promise<void> {
    const id = this.resolveItemId(itemName);
    if (id == null) throw new Error(`unknown item: ${itemName}`);

    const key = this.bot.registry.items[id]?.name ?? toItemId(itemName);
    const before = this.countItem(key);

    const inHand = this.bot.recipesFor(id, null, count, null);
    if (inHand.length > 0) {
      await this.bot.craft(inHand[0]!, count, undefined);
      await this.verifyCrafted(key, before, itemName);
      return;
    }

    const table = this.bot.findBlock({ matching: this.resolveBlockIds("crafting_table"), maxDistance: 32 });
    if (!table) throw new Error("need a crafting table and none is nearby");
    await this.bot.pathfinder.goto(new goals.GoalLookAtBlock(table.position, this.bot.world));
    const withTable = this.bot.recipesFor(id, null, count, table);
    if (withTable.length === 0) throw new Error(`can't craft ${itemName} (missing materials)`);
    await this.bot.craft(withTable[0]!, count, table);
    await this.verifyCrafted(key, before, itemName);
  }

  /**
   * 合成完回头看一眼背包。
   *
   * 「以为合成了」是最坑的一种假成功：craft 顺利返回、聊天里也报"做好了"，
   * 可背包里什么都没有 —— 材料其实不够、或者窗口早关了。
   */
  private async verifyCrafted(key: string, before: number, label: string): Promise<void> {
    const ok = await this.waitFor(() => this.countItem(key) > before, 1200);
    if (!ok) throw new Error(`合成 ${label} 没成功 —— 背包里一个都没多出来`);
  }

  nearestHostile(opts?: { maxDistance?: number; preferThreatTo?: Vec3Lit }): EntityInfo | null {
    const maxDistance = opts?.maxDistance ?? 16;
    const here = this.bot.entity.position;
    const ref = opts?.preferThreatTo
      ? new Vec3(opts.preferThreatTo.x, opts.preferThreatTo.y, opts.preferThreatTo.z)
      : here;
    const candidates = Object.values(this.bot.entities).filter(
      (e) => !!e.name && HOSTILE.has(e.name) && here.distanceTo(e.position) <= maxDistance,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => ref.distanceTo(a.position) - ref.distanceTo(b.position));
    const e = candidates[0]!;
    return { id: e.id, name: e.name!, pos: toLit(e.position), distance: round(here.distanceTo(e.position)) };
  }

  /** Find nearby entities by name, nearest first. Used by explore_for (villagers). */
  findEntities(names: string[], maxDistance = 48): EntityInfo[] {
    const want = new Set(names.map((n) => n.toLowerCase()));
    const here = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter((e) => !!e.name && want.has(e.name.toLowerCase()) && here.distanceTo(e.position) <= maxDistance)
      .map((e) => ({ id: e.id, name: e.name!, pos: toLit(e.position), distance: round(here.distanceTo(e.position)) }))
      .sort((a, b) => a.distance - b.distance);
  }

  // ── Containers ───────────────────────────────────────────────────────────

  async readContainer(pos: Vec3Lit): Promise<Array<{ item: string; count: number }>> {
    const block = await this.reachContainer(pos);
    const container = await this.bot.openContainer(block);
    const items = container.containerItems().map((i) => ({ item: i.name, count: i.count }));
    container.close();
    return items;
  }

  /** Pathfind into reach of a container coord, or throw a clean error. */
  private async reachContainer(pos: Vec3Lit) {
    const v = new Vec3(pos.x, pos.y, pos.z);
    const block = this.bot.blockAt(v);
    if (!block) throw new Error("no block at that position");
    await this.gotoSafe(new goals.GoalGetToBlock(pos.x, pos.y, pos.z), 10000);
    if (this.bot.entity.position.distanceTo(v) > 4.5) {
      throw new Error(`couldn't reach the container at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
    return block;
  }

  async withdrawFromContainer(pos: Vec3Lit, item: string, count?: number): Promise<number> {
    const id = this.resolveItemId(item);
    if (id == null) throw new Error(`unknown item: ${item}`);
    const block = await this.reachContainer(pos);
    const container = await this.bot.openContainer(block);
    try {
      const match = container.containerItems().find((i) => i.type === id);
      if (!match) return 0;
      const take = Math.min(count ?? match.count, match.count);
      await container.withdraw(match.type, null, take);
      return take;
    } finally {
      container.close();
    }
  }

  dimension(): string {
    return this.bot.game.dimension;
  }

  // ── Name resolution ──────────────────────────────────────────────────────

  /**
   * Map a friendly block name or group alias to concrete block ids.
   * 中文名也认（「橡木原木」→ oak_log），组别名（any_log / any_ore）照旧。
   */
  private resolveBlockIds(name: string): number[] {
    const key = toItemId(name).toLowerCase();
    const cached = this.blockIdCache.get(key);
    if (cached) return cached;

    const reg = this.bot.registry;
    const all = reg.blocksArray as Array<{ id: number; name: string }>;
    let ids: number[];
    switch (key) {
      case "any_log":
        ids = all.filter((b) => /(_log|_wood|_stem|_hyphae)$/.test(b.name)).map((b) => b.id);
        break;
      case "any_wood":
        ids = all.filter((b) => /(_log|_wood|_stem|_hyphae|_planks)$/.test(b.name)).map((b) => b.id);
        break;
      case "any_ore":
        ids = all.filter((b) => b.name.endsWith("_ore") || b.name === "ancient_debris").map((b) => b.id);
        break;
      case "any_stone":
        ids = all.filter((b) => STONE_NAMES.has(b.name)).map((b) => b.id);
        break;
      case "any_chest":
        ids = all
          .filter((b) => b.name === "chest" || b.name === "trapped_chest" || b.name === "barrel")
          .map((b) => b.id);
        break;
      default: {
        const b = reg.blocksByName[key];
        ids = b ? [b.id] : [];
      }
    }
    this.blockIdCache.set(key, ids);
    return ids;
  }

  /**
   * 名字 → 物品 id。
   *
   * 这里过一道中文转换：模型眼里的背包**全是中文**
   * （橡木原木 / 粗铁 / 下界合金锭），它调工具时自然说中文。
   * 中文查不到就当 id 原样试，让上层去报"没有这个东西"。
   */
  private resolveItemId(name: string): number | null {
    const key = toItemId(name);
    const it = this.bot.registry.itemsByName[key];
    return it ? it.id : null;
  }
}
