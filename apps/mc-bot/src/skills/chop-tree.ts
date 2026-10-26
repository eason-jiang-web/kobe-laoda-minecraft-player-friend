import type { Skill } from "./types.js";
import { runWithTask } from "./types.js";
import { connectedComponent } from "./_geometry.js";

/**
 * chop_tree() — find the nearest tree, mine its whole connected trunk (incl.
 * branches), and pick up the logs. The headline "do a real thing" skill.
 */
export const chopTree: Skill = {
  name: "chop_tree",
  description: "Find nearby trees, chop them from the bottom up, and collect the logs. args: { count } — 一棵不够就接着砍下一棵。",
  async run(ctx, args) {
    return runWithTask(ctx, async () => {
      // 一棵树只有 5~7 个木头，目标是 32 个的时候得砍好几棵 ——
      // 原来一次只砍一棵，目标永远攒不满（实测「弄不到更多了：0/16 oak_log」）。
      const want = typeof args?.count === "number" ? Math.max(1, Math.min(args.count, 64)) : 16;
      let chopped = 0;
      let tried = 0;
      for (let round = 0; round < 6 && chopped < want; round++) {
        const logs = await ctx.control.findBlocks({ name: "any_log", maxDistance: 32, count: 32 });
        if (logs.length === 0) break;
        // 从最低的那棵开始（脚边先砍）
        logs.sort((a, b) => a.y - b.y);
        const trunk = connectedComponent(logs, logs[0]!, 32);
        // bottom-up so we don't leave floating logs out of reach
        trunk.sort((a, b) => a.y - b.y);
        tried++;
        const mined = await ctx.control.mineMany(trunk);
        chopped += mined;
        // sweep the columns to vanilla-collect the logs, plus a best-effort entity grab
        await ctx.control.sweepColumns(trunk);
        await ctx.control.collectNearbyDrops({ radius: 6 });
        if (mined === 0) break; // 够不着就别空转
      }
      if (chopped > 0) return `chopped ${chopped} logs` + (tried > 1 ? ` (${tried} 棵)` : "");
      return "没砍到木头（附近没树，或者够不着）";
    });
  },
};
