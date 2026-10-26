import { describe, expect, test } from "bun:test";
import { activityLabel, guessPlayerActivity, skillForActivity } from "./activity.js";
import type { GameState } from "./types.js";

function state(over: Partial<GameState> = {}): GameState {
  return {
    at: 0,
    timeOfDay: 6000,
    self: {
      pos: { x: 0, y: 64, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      heldItem: null,
      onGround: true,
      dimension: "overworld",
    },
    player: { username: "eason", pos: { x: 2, y: 64, z: 0 }, distance: 2, online: true },
    nearbyHostiles: [],
    recentChat: [],
    inventory: [],
    followState: "IDLE",
    currentGoal: null,
    ...over,
  } as unknown as GameState;
}

describe("guessPlayerActivity — 看他在干嘛", () => {
  test("正对着木头 → 砍树（最可信的信号）", () => {
    const a = guessPlayerActivity(state({ self: { ...state().self, lookingAt: "oak_log" } }));
    expect(a.kind).toBe("chopping");
    expect(a.block).toBe("oak_log");
  });

  test("正对着矿石 → 挖矿，并记住是哪种矿", () => {
    const a = guessPlayerActivity(state({ self: { ...state().self, lookingAt: "iron_ore" } }));
    expect(a.kind).toBe("mining");
    expect(a.block).toBe("iron_ore");
  });

  test("正对着石头 → 也是挖矿", () => {
    expect(guessPlayerActivity(state({ self: { ...state().self, lookingAt: "deepslate" } })).kind).toBe("mining");
  });

  test("正对着工作台 → 在盖东西/合成", () => {
    expect(guessPlayerActivity(state({ self: { ...state().self, lookingAt: "crafting_table" } })).kind).toBe("building");
  });

  test("正对着庄稼 → 种地", () => {
    expect(guessPlayerActivity(state({ self: { ...state().self, lookingAt: "wheat" } })).kind).toBe("farming");
  });

  test("没对着方块就看手上的工具", () => {
    expect(guessPlayerActivity(state({ self: { ...state().self, heldItem: "iron_axe" } })).kind).toBe("chopping");
    expect(guessPlayerActivity(state({ self: { ...state().self, heldItem: "stone_pickaxe" } })).kind).toBe("mining");
    expect(guessPlayerActivity(state({ self: { ...state().self, heldItem: "wooden_sword" } })).kind).toBe("fighting");
  });

  test("旁边有怪 → 多半在打", () => {
    const a = guessPlayerActivity(
      state({ nearbyHostiles: [{ id: 1, name: "zombie", pos: { x: 1, y: 64, z: 0 }, distance: 2 }] }),
    );
    expect(a.kind).toBe("fighting");
  });

  test("什么都看不出来 → unknown（不瞎猜）", () => {
    expect(guessPlayerActivity(state()).kind).toBe("unknown");
  });

  test("标签是给玩家看的中文", () => {
    expect(activityLabel("chopping")).toBe("砍树");
    expect(activityLabel("mining")).toBe("挖矿");
  });
});

describe("skillForActivity — #follow play 该派什么活", () => {
  test("砍树 → chop_tree（带个数，别只砍一棵）", () => {
    const job = skillForActivity({ kind: "chopping", why: "" });
    expect(job?.name).toBe("chop_tree");
    expect(job?.args).toMatchObject({ count: 16 });
  });

  test("挖矿 → mine_vein，挖他正对着的那种", () => {
    const job = skillForActivity({ kind: "mining", why: "", block: "iron_ore" });
    expect(job).toEqual({ name: "mine_vein", args: { ore: "iron_ore" } });
  });

  test("打架 → combat_assist", () => {
    expect(skillForActivity({ kind: "fighting", why: "" })?.name).toBe("combat_assist");
  });

  test("看不出 / 不会的 → null（老实跟着，别硬编一个）", () => {
    expect(skillForActivity({ kind: "unknown", why: "" })).toBeNull();
    expect(skillForActivity({ kind: "farming", why: "" })).toBeNull();
  });
});
