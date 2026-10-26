import { describe, expect, test } from "bun:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
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

describe("自救 —— 够不着/看不见/卡住了自己想办法", () => {
  /** 造一个假身体；blockAt 用回调，方便按坐标编场景。 */
  function bot(over: Record<string, unknown>) {
    const fake: Record<string, unknown> = {
      username: "Laoda",
      chat: () => {},
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      setControlState: () => {},
      equip: async () => {},
      inventory: { items: () => [] },
      registry: { items: {}, itemsByName: {} },
      pathfinder: { goto: async () => {}, stop: () => {}, bestHarvestTool: () => null },
      dig: async () => {},
      blockAt: () => null,
      ...over,
    };
    return { fake, c: new BotController(fake as unknown as Bot, {} as Config) };
  }

  test("垫方块：位置真的升上去了才算成功", async () => {
    const { fake, c } = bot({
      inventory: { items: () => [{ name: "cobblestone", type: 1, count: 8 }] },
      blockAt: () => ({ name: "stone", boundingBox: "block", position: new Vec3(0, 63, 0) }),
      placeBlock: async () => {
        (fake.entity as { position: Vec3 }).position = new Vec3(0, 65, 0);
      },
    });
    expect(await c.pillarUp()).toBe(true);
  });

  test("垫方块：放了但没上去 → 老实说失败（不假装）", async () => {
    const { c } = bot({
      inventory: { items: () => [{ name: "cobblestone", type: 1, count: 8 }] },
      blockAt: () => ({ name: "stone", boundingBox: "block", position: new Vec3(0, 63, 0) }),
      placeBlock: async () => {},
    });
    expect(await c.pillarUp()).toBe(false);
  });

  test("垫方块：背包里没方块 → 直接失败", async () => {
    const { c } = bot({ inventory: { items: () => [] } });
    expect(await c.pillarUp()).toBe(false);
  });

  test("插火把：够黑 + 有火把 → 真的点亮了", async () => {
    let lit = false;
    const { c } = bot({
      entity: { position: new Vec3(0, 30, 0), onGround: true },
      inventory: { items: () => [{ name: "torch", type: 1, count: 4 }] },
      blockAt: (p: Vec3) =>
        p.y >= 30
          ? { name: "air", boundingBox: "empty", light: lit ? 7 : 0, skyLight: 0 }
          : { name: "stone", boundingBox: "block", light: 0, skyLight: 0, position: p },
      placeBlock: async () => {
        lit = true;
      },
    });
    expect(await c.ensureLight()).toBe(true);
  });

  test("插火把：已经很亮就不浪费火把", async () => {
    const { c } = bot({
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      inventory: { items: () => [{ name: "torch", type: 1, count: 4 }] },
      blockAt: () => ({ name: "air", boundingBox: "empty", light: 15, skyLight: 15 }),
    });
    expect(await c.ensureLight()).toBe(false);
  });

  test("插火把：没火把就老实说没点", async () => {
    const { c } = bot({
      entity: { position: new Vec3(0, 30, 0), onGround: true },
      inventory: { items: () => [] },
      blockAt: () => ({ name: "air", boundingBox: "empty", light: 0, skyLight: 0 }),
    });
    expect(await c.ensureLight()).toBe(false);
  });

  test("挖穿：隔着一堵墙会把挡路的那两格挖掉", async () => {
    const dug: Vec3[] = [];
    const { c } = bot({
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      blockAt: (p: Vec3) =>
        Math.floor(p.y) === 65 && Math.floor(p.z) >= 1 && Math.floor(p.z) <= 2
          ? { name: "stone", boundingBox: "block", position: p }
          : { name: "air", boundingBox: "empty", position: p },
      dig: async (b: { position: Vec3 }) => {
        dug.push(b.position);
      },
    });
    const n = await c.digThrough({ x: 0, y: 66, z: 4 });
    expect(n).toBeGreaterThan(0);
    expect(dug.length).toBe(n);
  });

  test("脱困：能蹦出去的就不挖方块", async () => {
    const { fake, c } = bot({
      setControlState: (k: string, v: boolean) => {
        if (k === "forward" && v) (fake.entity as { position: Vec3 }).position = new Vec3(0, 64, 2);
      },
    });
    expect(await c.unstuck()).toBe(true);
  });

  test("脱困：怎么都动不了 → 老实说没出来", async () => {
    const { c } = bot({});
    expect(await c.unstuck()).toBe(false);
  });
});

describe("mineMany —— 只数真的挖掉的（砍树只掉 1 个木头的根子）", () => {
  /** 一个"够得着、goto 成功"的假身体。 */
  function miningBot(blockStillThere: boolean) {
    let dug = 0;
    const bot = {
      username: "Laoda",
      chat: () => {},
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 }, onGround: true },
      blockAt: () => (blockStillThere || dug === 0 ? { name: "oak_log", position: { x: 0, y: 65, z: 0 } } : { name: "air" }),
      pathfinder: {
        goto: async () => {},
        stop: () => {},
        bestHarvestTool: () => ({ name: "iron_axe", type: 1 }),
      },
      dig: async () => {
        dug++;
      },
      equip: async () => {},
      setControlState: () => {},
      inventory: { items: () => [] },
      registry: { items: {}, itemsByName: {} },
    } as unknown as Bot;
    return new BotController(bot, {} as Config);
  }

  test("挖了但方块还在 → 不算（原来是「够不着也 +1」）", async () => {
    const c = miningBot(true);
    const n = await c.mineMany([{ x: 0, y: 65, z: 0 }]);
    expect(n).toBe(0);
  });

  test("方块真的没了 → 才算一个", async () => {
    const c = miningBot(false);
    const n = await c.mineMany([{ x: 0, y: 65, z: 0 }]);
    expect(n).toBe(1);
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
