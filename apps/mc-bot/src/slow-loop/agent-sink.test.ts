import { describe, expect, test } from "bun:test";
import type { GameState } from "@itto/shared";
import { brainEnv } from "./agent-sink.js";

const state = {
  at: 0,
  timeOfDay: 6000,
  self: { pos: { x: 0, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, health: 20, food: 20, heldItem: null, onGround: true, dimension: "overworld" },
  player: { username: "eason", pos: { x: 1, y: 64, z: 0 }, distance: 1, online: true },
  nearbyHostiles: [],
  recentChat: [],
  inventory: [],
  followState: "IDLE",
  currentGoal: null,
} as unknown as GameState;

describe("双模型 —— 有人跟你说话走快的，自己琢磨走聪明的", () => {
  test("优先唤醒（你说话了）-> 带上快模型", () => {
    const env = brainEnv("player said: 过来", state, true, { fastModel: "deepseek-flash" });
    expect(env.ITTO_BRAIN_MODEL).toBe("deepseek-flash");
  });

  test("自己找事的唤醒 -> 不指定，让大脑用默认的聪明模型", () => {
    const env = brainEnv("nothing to do", state, false, { fastModel: "deepseek-flash" });
    expect(env.ITTO_BRAIN_MODEL).toBeUndefined();
  });

  test("没配快模型 -> 一律不指定（单模型也能正常跑）", () => {
    expect(brainEnv("player said: 过来", state, true, {}).ITTO_BRAIN_MODEL).toBeUndefined();
  });

  test("唤醒原因和状态快照始终带上（训练日志要靠它）", () => {
    const env = brainEnv("player_in_danger", state, true, { fastModel: "deepseek-flash" });
    expect(env.ITTO_BRAIN_REASON).toBe("player_in_danger");
    expect(env.ITTO_BRAIN_STATE).toContain("eason");
  });
});
