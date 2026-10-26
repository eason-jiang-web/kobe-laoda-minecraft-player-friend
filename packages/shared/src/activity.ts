/**
 * 「他现在在干嘛」—— 靠他正对着什么、手上拿什么、身边有什么来推。
 *
 * 为什么要它：
 *   1. `#follow play` = 「跟我干一样的活」。玩家不会解释自己在干嘛，你得自己看出来。
 *   2. 学他的动作 —— 记下来他常干什么，闲下来的时候你也会偏向那个。
 *
 * 纯函数：给一份快照，给一个判断。好测，也不碰游戏。
 */
import type { GameState } from "./types.js";

export type PlayerActivity =
  | "chopping"
  | "mining"
  | "building"
  | "fighting"
  | "farming"
  | "exploring"
  | "unknown";

export interface ActivityGuess {
  kind: PlayerActivity;
  /** 为什么这么判断（也给玩家看，让他知道它是怎么想的）。 */
  why: string;
  /** 正对着/正在弄的那个方块（挖矿时用得上）。 */
  block?: string;
}

const LOG_ISH = /(_log|_wood|_stem|_hyphae)$/;
const ORE_ISH = /(_ore|ancient_debris)$/;
/** 挖得动、值得挖的常见方块。 */
const MINEABLE_ISH =
  /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|basalt|blackstone|netherrack|end_stone|sandstone|dirt|coarse_dirt|gravel|sand|red_sand|clay|obsidian|snow_block|ice|packed_ice|prismarine|mossy_cobblestone|amethyst_block)$/;
const BUILD_ISH = /(planks|_bricks|glass|wool|concrete|terracotta|_stairs|_slab|_fence|_wall|scaffolding)/;
const FARM_ISH = /^(wheat|carrots|potatoes|beetroots|farmland|melon_stem|pumpkin_stem|sugar_cane|pumpkin|melon|tall_grass|short_grass|grass_block)$/;
const STATION_ISH = /^(crafting_table|furnace|smithing_table|anvil|enchanting_table|brewing_stand|chest|barrel|hopper)$/;

/**
 * 判断他这会儿在干什么。
 * 优先级：正对着的方块 > 手上的工具 > 旁边的怪 —— 「看着什么」是最可信的信号。
 */
export function guessPlayerActivity(s: GameState): ActivityGuess {
  const looking = (s.self.lookingAt ?? "").toLowerCase();
  const held = (s.self.heldItem ?? "").toLowerCase();
  const nearPlayer = (s.player?.distance ?? 99) <= 16;

  if (looking.length > 0) {
    if (LOG_ISH.test(looking)) return { kind: "chopping", why: "他正对着一块木头", block: looking };
    if (ORE_ISH.test(looking)) return { kind: "mining", why: "他正对着矿石", block: looking };
    if (MINEABLE_ISH.test(looking)) return { kind: "mining", why: "他正对着石头/土", block: looking };
    if (FARM_ISH.test(looking)) return { kind: "farming", why: "他在地里", block: looking };
    if (STATION_ISH.test(looking)) return { kind: "building", why: "他在摆弄工作台/箱子", block: looking };
    if (BUILD_ISH.test(looking)) return { kind: "building", why: "他正对着建材", block: looking };
  }

  if (/_axe$/.test(held)) return { kind: "chopping", why: "他手上拿着斧子" };
  if (/_pickaxe$/.test(held)) return { kind: "mining", why: "他手上拿着镐子" };
  if (/_hoe$/.test(held)) return { kind: "farming", why: "他手上拿着锄头" };
  if (/_sword$/.test(held) || /bow$/.test(held)) return { kind: "fighting", why: "他拿着武器" };

  if (nearPlayer && s.nearbyHostiles.length > 0) return { kind: "fighting", why: "他旁边有怪" };

  return { kind: "unknown", why: "看不出他具体在干嘛" };
}

/** 这个活动在聊天里怎么说（短）。 */
export function activityLabel(kind: PlayerActivity): string {
  switch (kind) {
    case "chopping":
      return "砍树";
    case "mining":
      return "挖矿";
    case "building":
      return "盖东西";
    case "fighting":
      return "打架";
    case "farming":
      return "种地";
    case "exploring":
      return "探路";
    default:
      return "看不出";
  }
}

/**
 * 这类活该派哪个技能 —— `#follow play` 的核心。
 * 返回 null 表示「这个我真不会，先跟着你」。
 */
export function skillForActivity(a: ActivityGuess): { name: string; args?: Record<string, unknown> } | null {
  switch (a.kind) {
    case "chopping":
      return { name: "chop_tree", args: { count: 16 } };
    case "mining": {
      // 他对着什么就挖什么；对着土/沙这种没有矿脉概念的，就交给 find_blocks 挖它
      const ore = a.block ?? "any_ore";
      return { name: "mine_vein", args: { ore } };
    }
    case "fighting":
      return { name: "combat_assist" };
    case "building":
      return { name: "assist_mining" }; // 盖东西时帮他把料挖/搬出来
    default:
      return null;
  }
}
