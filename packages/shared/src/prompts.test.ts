import { describe, expect, test } from "bun:test";
import type { GameState } from "./types.js";
import { formatStateForPrompt } from "./prompts.js";

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
    player: { username: "eason", pos: { x: 1, y: 64, z: 0 }, distance: 1, online: true },
    nearbyHostiles: [],
    recentChat: [],
    inventory: [],
    followState: "IDLE",
    currentGoal: null,
    ...over,
  } as unknown as GameState;
}

describe("formatStateForPrompt —— 快照要说清「周围已经有什么」", () => {
  test("附近有工作台就写出来，并提醒别再做", () => {
    const text = formatStateForPrompt(
      state({ nearStations: [{ name: "crafting_table", distance: 3, pos: { x: 3, y: 64, z: 0 } }] }),
    );
    expect(text).toContain("附近有：");
    expect(text).toContain("工作台");
    expect(text).toContain("3b");
    expect(text).toContain("别再做一个");
  });

  test("熔炉和箱子也认", () => {
    const text = formatStateForPrompt(
      state({
        nearStations: [
          { name: "furnace", distance: 2, pos: { x: 2, y: 64, z: 0 } },
          { name: "chest", distance: 5, pos: { x: 5, y: 64, z: 0 } },
        ],
      }),
    );
    expect(text).toContain("熔炉");
    expect(text).toContain("箱子");
  });

  test("周围什么都没有就不打这一行（别塞废话）", () => {
    expect(formatStateForPrompt(state())).not.toContain("附近有");
    expect(formatStateForPrompt(state({ nearStations: [] }))).not.toContain("附近有");
  });
});
