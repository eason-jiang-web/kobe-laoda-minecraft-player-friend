import { describe, expect, test } from "bun:test";
import { matchCommand, type CommandContext } from "./chat-commands.js";

/** A stand-in body that records what the commands did to it. */
function harness(playerPos: { x: number; y: number; z: number } | null = { x: 10, y: 64, z: -20 }) {
  const calls: string[] = [];
  let pacifist = false;
  let epoch = 0;
  const goalRunning = true;
  const ctx = {
    control: {
      getState: () => ({
        player: playerPos ? { username: "eason", pos: playerPos, distance: 180, online: true } : null,
        inventory: [],
      }),
      teleportTo: async (p: { x: number; y: number; z: number }) => {
        calls.push("teleport:" + JSON.stringify(p));
      },
      // #back 走这条 —— 位置看不见时它会退回"按名字 tp"，所以这里只记名字
      teleportToPlayer: async (name?: string) => {
        calls.push("tp-player:" + (name ?? "owner"));
        return "ok";
      },
      setFreeRoam: (on: boolean) => calls.push("free:" + on),
      setPacifist: (on: boolean) => {
        pacifist = on;
        calls.push("pacifist:" + on);
      },
      isPacifist: () => pacifist,
      stop: () => calls.push("stop"),
      equip: async () => {},
      attack: async (id: number) => calls.push("attack:" + id),
      attackDirect: async (id: number) => calls.push("attack:" + id),
      attackOrder: () => epoch,
      cancelAttackOrders: () => {
        epoch++;
      },
      setHoldPosition: (on: boolean) => calls.push("stay:" + on),
      isHoldPosition: () => false,
      setMuted: (on: boolean) => calls.push("quiet:" + on),
      isMuted: () => false,
      chat: async (m: string) => calls.push("said:" + m),
      moveTo: async () => {},
      findEntities: () => [],
    },
    follow: { setFreeRoam: (on: boolean) => calls.push("follow-free:" + on), isFreeRoam: () => false },
    runner: {
      cancel: () => calls.push("cancel-goal"),
      currentGoal: () => (goalRunning ? { label: "砍树备料" } : null),
    },
  } as unknown as CommandContext;
  return {
    ctx,
    calls,
    setPacifist: (on: boolean) => {
      pacifist = on;
    },
  };
}

const run = (line: string, ctx: CommandContext) => {
  const hit = matchCommand(line);
  if (!hit) throw new Error("not a command: " + line);
  return hit.command.run(ctx, hit.arg);
};

describe("#follow play —— 跟我干一样的活", () => {
  /** 换一份"他正在干嘛"的快照，并记录派了什么技能。 */
  function withActivity(state: Record<string, unknown>) {
    const h = harness();
    (h.ctx.control as unknown as { getState: () => unknown }).getState = () => state;
    const skills: Array<{ name: string; args?: Record<string, unknown> }> = [];
    h.ctx.setSkill = (name: string, args?: Record<string, unknown>) => {
      skills.push({ name, args });
      return "跟着干：" + name;
    };
    return { ...h, skills };
  }

  const base = { player: { username: "eason", pos: { x: 2, y: 64, z: 0 }, distance: 2, online: true }, nearbyHostiles: [], inventory: [] };

  test("你在砍树 → 它去砍树（而且不止一棵）", async () => {
    const h = withActivity({ ...base, self: { lookingAt: "oak_log", heldItem: "iron_axe" } });
    const reply = await run("#follow play", h.ctx);
    expect(h.skills[0]?.name).toBe("chop_tree");
    expect(h.skills[0]?.args).toMatchObject({ count: 16 });
    expect(reply).toContain("砍树");
  });

  test("你在挖矿 → 挖你正对着的那种矿", async () => {
    const h = withActivity({ ...base, self: { lookingAt: "iron_ore", heldItem: "stone_pickaxe" } });
    await run("#follow play", h.ctx);
    expect(h.skills[0]).toEqual({ name: "mine_vein", args: { ore: "iron_ore" } });
  });

  test("旁边有怪 → 上来帮你打", async () => {
    const h = withActivity({ ...base, self: { lookingAt: null, heldItem: null }, nearbyHostiles: [{ id: 9, name: "zombie", pos: { x: 1, y: 64, z: 0 }, distance: 2 }] });
    const reply = await run("#follow play", h.ctx);
    expect(h.skills[0]?.name).toBe("combat_assist");
    expect(reply).toContain("打架");
  });

  test("看不出你在干嘛 → 老实说，还跟着你（不瞎派活）", async () => {
    const h = withActivity({ ...base, self: { lookingAt: null, heldItem: null } });
    const reply = await run("#follow play", h.ctx);
    expect(h.skills.length).toBe(0);
    expect(reply).toContain("看不出");
    expect(reply.length).toBeLessThanOrEqual(256);
  });
});

describe("#value", () => {
  test("with no argument it answers both 'what is worth it' and 'what are we short of'", async () => {
    const h = harness();
    const reply = await run("#value", h.ctx);
    // 一半是"值不值得"（空背包 → 没什么特别的），一半是"还缺什么"
    expect(reply).toContain("上限只是参考");
    expect(reply).toContain("还缺");
    expect(reply).toContain("｜"); // 全角竖线，拼两半
  });

  test("that reply still fits one Minecraft chat line (256)", async () => {
    const h = harness();
    expect((await run("#value", h.ctx)).length).toBeLessThanOrEqual(256);
  });
});

describe("matchCommand", () => {
  test("matches the commands however they're typed", () => {
    expect(matchCommand("#back")?.command.trigger).toBe("#back");
    expect(matchCommand("  #FREE  ")?.command.trigger).toBe("#free");
    expect(matchCommand("#stop")?.command.trigger).toBe("#stop");
    expect(matchCommand("#nonstop")?.command.trigger).toBe("#nonstop");
    expect(matchCommand("#cancel")?.command.trigger).toBe("#cancel");
    expect(matchCommand("#stay")?.command.trigger).toBe("#stay");
    expect(matchCommand("#here")?.command.trigger).toBe("#here");
    expect(matchCommand("#quiet")?.command.trigger).toBe("#quiet");
    expect(matchCommand("#talk")?.command.trigger).toBe("#talk");
  });

  test("#stop and #nonstop are not confused with each other", () => {
    expect(matchCommand("#nonstop")?.command.trigger).not.toBe("#stop");
    expect(matchCommand("#stopx")?.command.trigger).not.toBe("#stop");
  });

  test("takes an argument for #attack, keeping its original case", () => {
    const hit = matchCommand("#attack Zombie");
    expect(hit?.command.trigger).toBe("#attack");
    expect(hit?.arg).toBe("Zombie");
    expect(matchCommand("#attack")?.arg).toBe("");
  });

  test("does not swallow normal chat", () => {
    expect(matchCommand("back")).toBeNull();
    expect(matchCommand("#backup")).toBeNull();
    expect(matchCommand("牢大 #back 一下")).toBeNull();
    expect(matchCommand("#attackx zombie")).toBeNull();
    expect(matchCommand("")).toBeNull();
  });
});

describe("#free / #back", () => {
  test("#free stops following and stops auto-teleporting", async () => {
    const h = harness();
    const reply = await run("#free", h.ctx);
    expect(h.calls).toContain("follow-free:true");
    expect(h.calls).toContain("free:true");
    expect(reply).toContain("#back");
  });

  test("#back undoes #free and teleports to him", async () => {
    const h = harness();
    const reply = await run("#back", h.ctx);
    expect(h.calls).toContain("follow-free:false");
    expect(h.calls).toContain("free:false");
    expect(h.calls).toContain("tp-player:owner");
    expect(h.calls.indexOf("free:false")).toBeLessThan(h.calls.indexOf("tp-player:owner"));
    expect(reply).toContain("兄弟");
  });

  test("#back works even when the bot can't SEE him (no position at all)", async () => {
    // 实测过的坑：玩家在别的维度 / 离太远时客户端拿不到坐标，
    // 以前这种情况直接回"看不见你在哪"，等于瞬移废了一半。
    const h = harness(null);
    const reply = await run("#back", h.ctx);
    expect(h.calls).toContain("tp-player:owner");
    expect(reply).toContain("兄弟");
  });

  test("#back reports what the server actually said when it refuses", async () => {
    const h = harness();
    (h.ctx.control as unknown as { teleportToPlayer: () => Promise<string> }).teleportToPlayer =
      async () => {
        throw new Error("服务端不给瞬移权限（游戏里打一次 /op Laoda 就行）");
      };
    const reply = await run("#back", h.ctx);
    expect(reply).toContain("传不过去");
    expect(reply).toContain("/op Laoda");
  });
});

describe("#stop / #nonstop / #attack", () => {
  test("#stop holds fire, stops moving and drops the task", async () => {
    const h = harness();
    const reply = await run("#stop", h.ctx);
    expect(h.calls).toContain("pacifist:true");
    expect(h.calls).toContain("stop");
    expect(h.calls).toContain("cancel-goal");
    expect(reply).toContain("#nonstop");
  });

  test("#nonstop is what re-arms him", async () => {
    const h = harness();
    await run("#stop", h.ctx);
    const reply = await run("#nonstop", h.ctx);
    expect(h.calls).toContain("pacifist:false");
    expect(reply).toContain("打");
  });

  test("#attack is a direct order: it swings even while holding fire", async () => {
    const h = harness();
    await run("#stop", h.ctx);

    let looks = 0;
    (h.ctx.control as unknown as { findEntities: () => unknown[] }).findEntities = () =>
      looks++ < 2 ? [{ id: 7, name: "zombie", pos: { x: 1, y: 64, z: 1 }, distance: 2 }] : [];

    const reply = await run("#attack zombie", h.ctx);
    expect(h.calls.some((c) => c.startsWith("attack:7"))).toBe(true); // it really swung
    expect(h.calls).not.toContain("pacifist:false"); // ...without lifting hold-fire
    expect(h.ctx.control.isPacifist()).toBe(true);
    expect(reply).toContain("#nonstop"); // and it says hold-fire is still on
  });

  test("#stop cancels a fight that is already swinging", async () => {
    const h = harness();
    // This one never dies, so only the cancel can end the routine.
    (h.ctx.control as unknown as { findEntities: () => unknown[] }).findEntities = () => [
      { id: 7, name: "zombie", pos: { x: 1, y: 64, z: 1 }, distance: 2 },
    ];
    const fight = run("#attack zombie", h.ctx);
    await new Promise((r) => setTimeout(r, 50));
    await run("#stop", h.ctx);
    expect(await fight).toContain("放一马");
  });

  test("#attack works once you say #nonstop", async () => {
    const h = harness();
    await run("#stop", h.ctx);
    await run("#nonstop", h.ctx);

    // The target exists for the initial look + one swing, then it's dead —
    // otherwise the (real, 15s) fight loop would keep swinging.
    let looks = 0;
    (h.ctx.control as unknown as { findEntities: () => unknown[] }).findEntities = () =>
      looks++ < 2 ? [{ id: 7, name: "zombie", pos: { x: 1, y: 64, z: 1 }, distance: 2 }] : [];

    const reply = await run("#attack zombie", h.ctx);
    expect(h.calls.some((c) => c.startsWith("attack:7"))).toBe(true);
    expect(reply).toContain("收拾完了");
  });

  test("#cancel drops the task without holding fire or leaving the group", async () => {
    const h = harness();
    const reply = await run("#cancel", h.ctx);
    expect(h.calls).toContain("cancel-goal");
    expect(reply).toContain("砍树备料");
    expect(h.calls).not.toContain("pacifist:true");
    expect(h.calls).not.toContain("follow-free:true");
  });

  test("#stay stops everything and parks him", async () => {
    const h = harness();
    const reply = await run("#stay", h.ctx);
    expect(h.calls).toContain("cancel-goal");
    expect(h.calls).toContain("follow-free:true");
    expect(h.calls).toContain("free:true");
    expect(h.calls).toContain("stay:true");
    expect(reply).toContain("#here");
  });

  test("#here undoes #stay and walks over instead of teleporting", async () => {
    const h = harness();
    await run("#stay", h.ctx);
    const moved: Array<Record<string, unknown>> = [];
    (h.ctx.control as unknown as { moveTo: (p: unknown, o: unknown) => Promise<void> }).moveTo = async (_p, o) => {
      moved.push(o as Record<string, unknown>);
    };
    const reply = await run("#here", h.ctx);
    expect(h.calls).toContain("follow-free:false");
    expect(h.calls).toContain("stay:false");
    expect(moved[0]?.noTeleport).toBe(true); // walked, didn't pop in
    expect(reply).toContain("到了");
  });

  test("#quiet / #talk flip the mute switch", async () => {
    const h = harness();
    expect(await run("#quiet", h.ctx)).toContain("安静");
    expect(h.calls).toContain("quiet:true");
    expect(await run("#talk", h.ctx)).toContain("话");
    expect(h.calls).toContain("quiet:false");
  });

  test("#attack without a target explains the usage", async () => {
    const h = harness();
    expect(await run("#attack", h.ctx)).toContain("#attack");
  });

  test("#attack reports honestly when the thing isn't around", async () => {
    const h = harness();
    expect(await run("#attack zombie", h.ctx)).toContain("没看到");
  });
});
