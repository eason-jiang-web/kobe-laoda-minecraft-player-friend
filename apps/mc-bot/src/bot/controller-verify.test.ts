import { describe, expect, test } from "bun:test";
import type { Bot } from "mineflayer";
import type { Config } from "../config.js";
import { BotController } from "./controller.js";

/**
 * 「真的操作」还是「以为在操作」—— 这组测试盯的就是这个。
 *
 * 假 bot 的每个动作都**顺利返回但世界没变**，正是线上最坑的那种假成功：
 * mineflayer 的调用成功了，可方块还在、东西没丢、背包没多。
 */
function make(over: Record<string, unknown>): BotController {
  const bot = {
    username: "Laoda",
    chat: () => {},
    inventory: { items: () => [] },
    registry: { items: {}, itemsByName: {} },
    ...over,
  } as unknown as Bot;
  return new BotController(bot, {} as Config);
}

describe("mineBlock —— 挖完要回头看一眼", () => {
  test("dig 顺利返回但方块还在 → 明确报错，不假装挖到了", async () => {
    const c = make({
      blockAt: () => ({ name: "stone" }),
      dig: async () => {}, // "成功"，但方块纹丝不动
    });
    await expect(c.mineBlock({ x: 0, y: 64, z: 0 })).rejects.toThrow("方块还在");
  });

  test("方块真的没了 → 正常通过", async () => {
    let dug = false;
    const c = make({
      blockAt: () => (dug ? { name: "air" } : { name: "stone" }),
      dig: async () => {
        dug = true;
      },
    });
    await expect(c.mineBlock({ x: 0, y: 64, z: 0 })).resolves.toBeUndefined();
  });
});

describe("dropItem —— 丢完要确认背包真的少了", () => {
  test("toss 返回了但东西还在背包 → 报错", async () => {
    const items = [{ name: "stone_pickaxe", type: 1, count: 1 }];
    const c = make({ inventory: { items: () => items }, toss: async () => {} });
    await expect(c.dropItem("stone_pickaxe", 1)).rejects.toThrow("没丢出去");
  });

  test("背包真的少了 → 正常通过", async () => {
    let items = [{ name: "stone_pickaxe", type: 1, count: 1 }];
    const c = make({
      inventory: { items: () => items },
      toss: async () => {
        items = [];
      },
    });
    await expect(c.dropItem("stone_pickaxe", 1)).resolves.toBeUndefined();
  });
});

describe("craft —— 「以为合成了」是最坑的假成功", () => {
  test("craft 返回了但背包没多东西 → 报错", async () => {
    const c = make({
      registry: { itemsByName: { stone_pickaxe: { id: 5 } }, items: { 5: { name: "stone_pickaxe" } } },
      recipesFor: () => [{}],
      craft: async () => {},
    });
    await expect(c.craft("stone_pickaxe", 1)).rejects.toThrow("没成功");
  });

  test("背包里真的多了一个 → 正常通过", async () => {
    let items: Array<{ name: string; type: number; count: number }> = [];
    const c = make({
      inventory: { items: () => items },
      registry: { itemsByName: { stone_pickaxe: { id: 5 } }, items: { 5: { name: "stone_pickaxe" } } },
      recipesFor: () => [{}],
      craft: async () => {
        items = [{ name: "stone_pickaxe", type: 5, count: 1 }];
      },
    });
    await expect(c.craft("stone_pickaxe", 1)).resolves.toBeUndefined();
  });
});
