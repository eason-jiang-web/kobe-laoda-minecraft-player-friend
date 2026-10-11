import type { Bot } from "mineflayer";
import type { ChatLine, GameState, Vec3Lit } from "@itto/shared";
import { HOSTILE } from "./hostiles.js";

/** Rolling chat buffer. The fast loop pushes into this; we snapshot it here. */
const recentChat: ChatLine[] = [];
const MAX_CHAT = 8;

export function pushChat(username: string, message: string): void {
  recentChat.push({ username, message, at: Date.now() });
  while (recentChat.length > MAX_CHAT) recentChat.shift();
}

function lit(v: { x: number; y: number; z: number }): Vec3Lit {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

/**
 * 会扫的设施。别贪多：每种都要 findBlock 一次。
 * 这三个是"决定下一步干什么"用得上的（工作台能合成、熔炉能烧、箱子能取）。
 */
export const STATION_BLOCKS = ["crafting_table", "furnace", "chest"] as const;
const STATION_RADIUS = 16;
/** 缓存 2 秒：getState 被高频调用（慢循环每 4 秒、每次 MCP 读状态），不能每次全量扫。 */
const STATION_TTL_MS = 2000;

let stationCache: { at: number; list: Array<{ name: string; distance: number; pos: Vec3Lit }> } | null = null;

function scanStations(bot: Bot): Array<{ name: string; distance: number; pos: Vec3Lit }> {
  const now = Date.now();
  if (stationCache && now - stationCache.at < STATION_TTL_MS) return stationCache.list;

  const here = bot.entity.position;
  const list: Array<{ name: string; distance: number; pos: Vec3Lit }> = [];
  for (const name of STATION_BLOCKS) {
    const id = bot.registry.blocksByName[name]?.id;
    if (typeof id !== "number") continue;
    try {
      const block = bot.findBlock({ matching: [id], maxDistance: STATION_RADIUS });
      if (block) {
        list.push({ name, distance: round(here.distanceTo(block.position)), pos: lit(block.position) });
      }
    } catch {
      // 区块没加载完会抛 —— 看不到就没看到，别把快照搞挂
    }
  }
  list.sort((a, b) => a.distance - b.distance);
  stationCache = { at: now, list };
  return list;
}
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Snapshot the world into a compact JSON object. Called every fast-loop tick
 * (cheap — pure reads off Mineflayer's in-memory state, no I/O). This is the
 * heart of "no-vision-first": structured state instead of screenshots.
 */
export function extractGameState(bot: Bot, ownerUsername: string): GameState {
  const self = bot.entity;
  const player = bot.players[ownerUsername]?.entity ?? null;

  const hostiles = Object.values(bot.entities)
    .filter((e) => e.name && HOSTILE.has(e.name))
    .map((e) => ({
      id: e.id,
      name: e.name!,
      pos: lit(e.position),
      distance: round(self.position.distanceTo(e.position)),
    }))
    .filter((e) => e.distance < 24)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);

  const heldItem = bot.heldItem?.name ?? null;

  // Held tool durability, if the held item is damageable.
  let heldDurability: { current: number; max: number } | undefined;
  if (bot.heldItem) {
    const max = bot.registry.items[bot.heldItem.type]?.maxDurability;
    const used = (bot.heldItem as { durabilityUsed?: number }).durabilityUsed;
    if (typeof max === "number" && max > 0 && typeof used === "number") {
      heldDurability = { current: max - used, max };
    }
  }

  // What the owner is currently aiming at — cheap raycast, guarded so it never throws.
  let lookingAt: string | null = null;
  if (player) {
    try {
      const lb = bot.blockAtEntityCursor(player, 6);
      lookingAt = lb && lb.name !== "air" ? lb.name : null;
    } catch {
      lookingAt = null;
    }
  }

  return {
    at: Date.now(),
    timeOfDay: bot.time.timeOfDay,
    self: {
      pos: lit(self.position),
      vel: lit(self.velocity),
      health: Math.round(bot.health),
      food: Math.round(bot.food),
      heldItem,
      lookingAt,
      heldDurability,
      onGround: self.onGround,
      dimension: bot.game.dimension,
    },
    player: bot.players[ownerUsername]
      ? {
          username: ownerUsername,
          pos: player ? lit(player.position) : null,
          distance: player ? round(self.position.distanceTo(player.position)) : null,
          online: true,
        }
      : { username: ownerUsername, pos: null, distance: null, online: false },
    nearbyHostiles: hostiles,
    recentChat: [...recentChat],
    inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
    // 环境里已经有的东西 —— 别再做一个
    nearStations: scanStations(bot),
    // 在线的人（不含自己）。物资目标要按人数缩放，所以这个必须有。
    players: Object.keys(bot.players).filter((u) => u !== bot.username),
    followState: "IDLE", // overwritten by the fast loop's follow SM each tick
    currentGoal: null, // stamped by the goal runner each tick (see index.ts)
    lastGoal: null, // stamped by the goal runner each tick (see index.ts)
  };
}
