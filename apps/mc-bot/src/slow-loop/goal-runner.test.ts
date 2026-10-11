import { describe, expect, test } from "bun:test";
import type { BotControl, BotGoal, GameState } from "@itto/shared";
import { gatherSkillFor, GoalRunner, namesFor } from "./goal-runner.js";

/** Flush the microtask queue so a started skill/async step settles. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const state = {
    inventory: [] as Array<{ name: string; count: number }>,
    player: { username: "eason", pos: { x: 0, y: 64, z: 0 }, distance: 2, online: true },
    self: { pos: { x: 0, y: 64, z: 0 } },
  };
  let itemEntities: Array<{ id: number; name: string; pos: { x: number; y: number; z: number }; distance: number }> = [];
  const dropped: Array<{ name: string; count: number }> = [];
  const skills: string[] = [];
  const completed: BotGoal[] = [];

  const control = {
    getState: () => state as unknown as GameState,
    chat: async () => {},
    stop: () => {},
    moveTo: async () => {},
    dropItem: async (name: string, count = 1) => {
      dropped.push({ name, count });
      // dropping puts an item entity on the ground at his feet
      itemEntities = [{ id: 1, name: "item", pos: { x: 0, y: 64, z: 0 }, distance: 1 }];
    },
    findEntities: (names: string[]) => (names.includes("item") ? itemEntities : []),
  } as unknown as BotControl;

  const runner = new GoalRunner({
    control,
    runSkill: async (name) => {
      skills.push(name);
      return "ran " + name;
    },
    suspendFollow: () => {},
    resumeFollow: () => {},
    onComplete: (g) => completed.push(g),
  });

  return {
    runner,
    state,
    dropped,
    skills,
    completed,
    pickedUp: () => {
      itemEntities = [];
    },
  };
}

describe("collect — verified by the inventory, not by the skill returning", () => {
  test("keeps gathering until the count is really there", async () => {
    const h = harness();
    h.runner.setGoal({ kind: "collect", item: "oak_log", count: 32 }, "get 32 logs");

    h.runner.tick();
    await settle();
    expect(h.skills).toEqual(["chop_tree"]); // picked the right tool for logs
    expect(h.runner.currentGoal()?.status).toBe("active"); // NOT done just because the skill ran

    h.state.inventory = [{ name: "oak_log", count: 40 }];
    h.runner.tick();
    expect(h.runner.currentGoal()).toBeNull();
    expect(h.completed.at(-1)?.status).toBe("done");
    expect(h.completed.at(-1)?.progress).toContain("40/32");
  });

  test("does not stack gather rounds while one is running", async () => {
    const h = harness();
    h.runner.setGoal({ kind: "collect", item: "oak_log", count: 64 }, "get 64 logs");
    h.runner.tick();
    h.runner.tick();
    h.runner.tick();
    await settle();
    expect(h.skills).toEqual(["chop_tree"]); // exactly one round in flight
  });

  test("gives up honestly after MAX_ROUNDS and says how far it got", async () => {
    const h = harness();
    h.runner.setGoal({ kind: "collect", item: "diamond", count: 8 }, "get diamonds");
    for (let i = 0; i < 8; i++) {
      h.runner.tick();
      await settle();
    }
    const goal = h.completed.at(-1);
    expect(goal?.status).toBe("failed");
    expect(goal?.error).toContain("0/8");
    expect(h.skills.every((s) => s === "mine_vein")).toBe(true);
  });

  test("fails fast on something it has no way to gather", () => {
    const h = harness();
    // 下界之星不是挖出来的（打凋灵掉的）—— 这种才该老实认输
    h.runner.setGoal({ kind: "collect", item: "nether_star", count: 1 }, "get a nether star");
    h.runner.tick();
    expect(h.completed.at(-1)?.status).toBe("failed");
    expect(h.completed.at(-1)?.error).toContain("不知道去哪弄");
    expect(h.completed.at(-1)?.error).toContain("合成");
  });
});

describe("物品来源常识 —— 「刨 8 个石头做石镐」不该死在这儿", () => {
  test("圆石：去挖石头（以前直接是「不知道用什么办法」）", () => {
    expect(gatherSkillFor("cobblestone")).toEqual({ name: "mine_vein", args: { ore: "stone" } });
  });

  test("石头：也是挖石头（挖出来叫圆石，下面有等价物兜着）", () => {
    expect(gatherSkillFor("stone")).toEqual({ name: "mine_vein", args: { ore: "stone" } });
  });

  test("泥土/沙子/砂砾/黑曜石：本身就是方块，挖就完了", () => {
    for (const item of ["dirt", "sand", "gravel", "obsidian", "netherrack"]) {
      expect(gatherSkillFor(item)).toEqual({ name: "mine_vein", args: { ore: item } });
    }
  });

  test("燧石来自挖砂砾、黏土球来自挖黏土", () => {
    expect(gatherSkillFor("flint")).toEqual({ name: "mine_vein", args: { ore: "gravel" } });
    expect(gatherSkillFor("clay_ball")).toEqual({ name: "mine_vein", args: { ore: "clay" } });
  });

  test("木头和矿石照旧", () => {
    expect(gatherSkillFor("oak_log")).toEqual({ name: "chop_tree" });
    expect(gatherSkillFor("iron_ore")).toEqual({ name: "mine_vein", args: { ore: "iron_ore" } });
    expect(gatherSkillFor("raw_iron")).toEqual({ name: "mine_vein", args: { ore: "iron_ore" } });
  });

  test("「石头」在背包里算上圆石 —— 不然挖完也永远数不到", () => {
    expect(namesFor("stone")).toContain("cobblestone");
    expect(namesFor("oak_log")).toEqual(["oak_log"]); // 没写别名的不受影响
  });

  test("收集石头：背包里是圆石也算完成（实测就是卡在这儿）", () => {
    const h = harness();
    h.state.inventory = [{ name: "cobblestone", count: 20 }];
    h.runner.setGoal({ kind: "collect", item: "stone", count: 20 }, "刨 20 个石头");
    h.runner.tick();
    expect(h.completed.at(-1)?.status).toBe("done");
    expect(h.completed.at(-1)?.progress).toContain("20/20");
  });

  test("收集圆石：会真的去挖石头", async () => {
    const h = harness();
    h.runner.setGoal({ kind: "collect", item: "cobblestone", count: 8 }, "刨8个石头做石镐");
    h.runner.tick();
    await settle();
    expect(h.skills).toEqual(["mine_vein"]);
    expect(h.runner.currentGoal()?.status).toBe("active"); // 没挖到就别说完成了
  });
});

describe("deliver — verified by him actually picking it up", () => {
  test("fails immediately when the items are not in the bag", () => {
    const h = harness();
    h.runner.setGoal({ kind: "deliver", items: [{ name: "stone_pickaxe", count: 1 }] }, "hand over pickaxe");
    h.runner.tick();
    expect(h.completed.at(-1)?.status).toBe("failed");
    expect(h.completed.at(-1)?.error).toContain("stone_pickaxe");
  });

  test("缺东西时如实报「有几个 / 要几个」，不把有的说成没有", () => {
    const h = harness();
    // 实测：它手上拿着工作台，报错却说「不够：工作台×1、橡木原木×12」，看着像两样都没有
    h.state.inventory = [
      { name: "crafting_table", count: 1 },
      { name: "oak_log", count: 4 },
    ];
    h.runner.setGoal(
      { kind: "deliver", items: [{ name: "crafting_table", count: 1 }, { name: "oak_log", count: 12 }] },
      "把工作台和木头交给 eason",
    );
    h.runner.tick();
    const err = h.completed.at(-1)?.error ?? "";
    expect(h.completed.at(-1)?.status).toBe("failed");
    // 只报真正缺的那个，而且带上"有 4 / 要 12"
    expect(err).toContain("oak_log 4/12");
    expect(err).not.toContain("crafting_table");
  });

  test("drops the stuff, then waits for the pickup before calling it done", async () => {
    const h = harness();
    h.state.inventory = [{ name: "stone_pickaxe", count: 1 }];
    h.runner.setGoal({ kind: "deliver", items: [{ name: "stone_pickaxe", count: 1 }] }, "hand over pickaxe");

    h.runner.tick();
    await settle();
    expect(h.dropped).toEqual([{ name: "stone_pickaxe", count: 1 }]);
    expect(h.runner.currentGoal()?.status).toBe("active"); // dropped ≠ delivered

    h.runner.tick(); // items still on the ground -> still not done
    expect(h.runner.currentGoal()?.status).toBe("active");

    h.pickedUp();
    h.runner.tick();
    expect(h.completed.at(-1)?.status).toBe("done");
    expect(h.completed.at(-1)?.progress).toContain("收下");
  });
});

describe("completion feedback", () => {
  test("real work reports back, trivial say/follow does not", async () => {
    const h = harness();
    h.runner.setGoal({ kind: "say", text: "yo" }, "say yo");
    h.runner.tick();
    await settle();
    expect(h.completed.length).toBe(0);

    h.runner.setGoal({ kind: "skill", name: "chop_tree" }, "chop a tree");
    h.runner.tick();
    await settle();
    expect(h.completed.length).toBe(1);
    expect(h.completed[0]?.status).toBe("done");
  });
});
