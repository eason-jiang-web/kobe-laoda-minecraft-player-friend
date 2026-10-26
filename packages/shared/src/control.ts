import type {
  BlockQuery,
  EntityInfo,
  GameState,
  LookedAtBlock,
  NotableBlock,
  Vec3Lit,
} from "./types.js";

/**
 * The single control surface over the Mineflayer bot.
 *
 * Implemented once in apps/mc-bot (src/bot/controller.ts) against a live
 * Mineflayer instance, then injected into:
 *   - the skill executor (apps/mc-bot/src/skills)
 *   - the MCP tools (packages/mcp-server/src/tools)
 *
 * Defining it here keeps the dependency arrow pointing the right way:
 * mcp-server depends on @itto/shared (this interface), never on the app.
 */
export interface BotControl {
  /**
   * Pathfind to within `range` blocks of target. Sprint optional.
   * `noTeleport` forces an actual walk even when an op /tp shortcut is available
   * (used by "#here" — come to me, but don't pop in out of thin air).
   */
  moveTo(target: Vec3Lit, opts?: { range?: number; sprint?: boolean; noTeleport?: boolean }): Promise<void>;

  /** `/tp` style snap — only works if the bot is server op. Used as the >30 block fallback. */
  teleportTo(target: Vec3Lit): Promise<void>;
  /** 瞬移到某个玩家身边（不填就是 owner）。看不见人也该过得去 —— 按名字让服务端找。 */
  teleportToPlayer(name?: string): Promise<string>;

  /** Aim the bot's head at a point (for "look at player" idle + pointing). */
  lookAt(target: Vec3Lit): Promise<void>;

  mineBlock(pos: Vec3Lit): Promise<void>;
  placeBlock(pos: Vec3Lit, item: string): Promise<void>;
  dropItem(name: string, count?: number): Promise<void>;
  equip(name: string, destination?: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand"): Promise<void>;
  attack(entityId: number): Promise<void>;

  /** Send an in-game chat message (text channel, not Discord voice). */
  chat(message: string): Promise<void>;

  /**
   * **大脑专用**的说话口：同一句话（或近似重复）刚说过就不再发。
   *
   * 为什么单独开一个而不是改 chat()：硬指令的回复（#back 之类）该能重复 ——
   * 你问两遍它就答两遍，那是对的。只有大脑"主动找话说"才需要这道刹车。
   * 返回 ok:false 时**一个字都没发出去**，why 直接给模型看。
   */
  chatIfNew(message: string): Promise<{ ok: boolean; why?: string }>;

  /**
   * Run a server command through the chat bar ("time set day" — the slash is
   * optional). Only commands on the configured allow-list actually run, and the
   * return value includes the server's own reply so the brain learns whether it
   * worked (permission denied, unknown command, ...).
   */
  runServerCommand(command: string): Promise<string>;

  /** Latest compact world snapshot. Cheap — read from cached game state. */
  getState(): GameState;

  /** Cancel any in-flight pathfinding / actions. The fast loop calls this on safety overrides. */
  stop(): void;

  // ── Perception (on-demand; kept OUT of GameState to stay token-cheap) ──

  /** Search nearby blocks by friendly name/alias. Returns coords, nearest-first. */
  findBlocks(query: BlockQuery): Promise<Vec3Lit[]>;

  /** What block the given player (default owner) is looking at, within maxDistance. */
  lookingAt(opts?: { player?: string; maxDistance?: number }): Promise<LookedAtBlock | null>;

  /** Cheap nearest-notable scan (logs/ores/water/chests). */
  nearbyNotable(maxDistance?: number): Promise<NotableBlock[]>;

  /** Unit direction the owner is facing (from yaw/pitch). For scouting ahead. */
  playerHeading(player?: string): Vec3Lit | null;

  /**
   * Free roam (#free): the body isn't following the player and won't auto-/tp
   * to him, however far he wanders.
   */
  isFreeRoam(): boolean;

  /** Hold fire (#stop): attack() refuses until something re-arms it. */
  isPacifist(): boolean;

  /** Waiting in place (#stay): no following, no wandering off to play. */
  isHoldPosition(): boolean;

  /** Quiet (#quiet): he stops volunteering lines, but still answers you. */
  isMuted(): boolean;

  /** Guide mode (#guide mode): he walks you through the main quest. */
  isGuide(): boolean;

  /**
   * Find nearby entities by name ("villager", "iron_golem", "item", "cow").
   * Nearest first. This is how "is there a village over there?" gets answered
   * without a screenshot: villagers are entities, not blocks.
   */
  findEntities(names: string[], maxDistance?: number): EntityInfo[];

  // ── Mid-level action primitives (path-aware; composed by skills) ──

  /** Pathfind adjacent to a block and mine it (auto-equips the best tool). */
  /**
   * 挖掉一个方块。够不着会自己想办法（跳 / 钻进树干），
   * 返回 true 只代表**方块真的没了**。
   */
  digAt(pos: Vec3Lit): Promise<boolean>;

  /** Path to + mine a list of coords in order, best-effort. Returns count mined. */
  mineMany(positions: Vec3Lit[]): Promise<number>;

  /**
   * **垫一格往上爬**（拿背包里的方块）。够不着的树顶就靠它。
   * 返回 true = 真的升上去了（不是"以为垫了"）。
   */
  pillarUp(): Promise<boolean>;

  /**
   * **太黑了就自己插火把**（挖矿下井时用），不用等大脑发话。
   * 返回 true = 真的插上了、而且真的亮了。
   */
  ensureLight(): Promise<boolean>;

  /** **把挡在路上的方块挖掉**（目标在墙后面）。返回挖掉几块。 */
  digThrough(target: Vec3Lit): Promise<number>;

  /** **卡住了自救**：蹦一下 / 挖开身边的方块。返回 true = 位置真的变了。 */
  unstuck(): Promise<boolean>;

  /** Walk to + pick up dropped item entities within radius. Returns count collected. */
  collectNearbyDrops(opts?: { radius?: number; timeoutMs?: number }): Promise<number>;

  /** Walk the X/Z columns of mined blocks so vanilla pickup grabs the drops. */
  sweepColumns(positions: Vec3Lit[]): Promise<void>;

  /** Craft `count` of an item by name; finds/uses a nearby crafting table if needed. */
  craft(itemName: string, count?: number): Promise<void>;

  /** Nearest hostile mob, optionally ranked by threat to a point (the player). */
  nearestHostile(opts?: { maxDistance?: number; preferThreatTo?: Vec3Lit }): EntityInfo | null;

  // ── Containers (M3 world memory) ──

  /** Open a container at a coord, read its contents, close it. Container-side items only. */
  readContainer(pos: Vec3Lit): Promise<Array<{ item: string; count: number }>>;

  /** Open a container, withdraw up to `count` of `item`, close it. Returns amount taken. */
  withdrawFromContainer(pos: Vec3Lit, item: string, count?: number): Promise<number>;

  /** Current dimension string ("overworld" | "the_nether" | "the_end"). */
  dimension(): string;
}
