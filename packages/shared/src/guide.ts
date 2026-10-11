/**
 * 向导模式的知识底座。
 *
 * 两件事：
 *   1. **世界准则**（GUIDE_KNOWLEDGE）—— Minecraft 的规矩：工具等级、亮度刷怪、
 *      挖矿 y 坐标、传送门怎么开…… 这些是"适应环境"的前提：不懂规则就不可能灵活。
 *      它是**静态**文本，塞进大脑的 system prompt 开头（稳定前缀 = 能吃到
 *      DeepSeek 的上下文缓存），所以常驻也不贵。
 *   2. **通关流程 + 进度判定**（STAGES）—— 把原版主线切成 10 步，每步给一个
 *      "怎么判断他已经过了这步"的纯函数（只看背包和维度），外加**这步该干嘛**
 *      和**我可以用哪些技能帮他**。
 *
 * 诚实说明：机器人看不到**玩家**的背包，所以进度是用"自己的背包 + 当前维度"
 * 推断的**近似值**。它是给大脑的提示，不是判决书 —— 不确定时它会开口问你。
 */
import { valueReport } from "./value.js";
import type { GameState, InventoryItem } from "./types.js";

function count(state: GameState, match: (name: string) => boolean): number {
  return state.inventory.filter((i: InventoryItem) => match(i.name)).reduce((n, i) => n + i.count, 0);
}

const has = (state: GameState, name: string) => count(state, (n) => n === name) > 0;
const hasAny = (state: GameState, names: string[]) => names.some((n) => has(state, n));
const hasMatch = (state: GameState, rx: RegExp) => count(state, (n) => rx.test(n)) > 0;

/** 世界准则：常驻在大脑的 system prompt 里。短、准、能用。 */
export const GUIDE_KNOWLEDGE = [
  "## Minecraft 世界准则（你本来就懂，这里只列容易记错的）",
  "- 一天 20 分钟：白天约 10 分钟，夜晚约 7 分钟。**黑暗中（亮度 0）会刷怪** —— 火把是保命的。",
  "- 工具等级决定能挖什么：木/金 < 石 < 铁 < 钻石 < 下界合金。**钻石必须铁镐以上**，否则挖了不掉。",
  "- 挖矿 y 坐标：铁 y≈15~56；钻石 y≈-59~-53（越深越好，带水桶防岩浆）；远古残骸在下界 y≈8~22。",
  "- 岩浆能用水桶浇成黑曜石；掉进岩浆基本等于把背包送人。",
  "- 饥饿度低不能回血；跑步、跳跃、挖矿都消耗饱食度。",
  "- 床可以跳过夜晚并设重生点；**下界/末地放床会爆炸**。",
  "- 下界传送门 = 10 个黑曜石 + 打火石。下界走 1 格 = 主世界 8 格（赶路神器）。",
  "- 末影之眼 = 末影珍珠 + 烈焰粉，用来找要塞（准备 12 个左右）；末地传送门在要塞里。",
  "- **上面这些数字都是区间，不是死线**：说 y≈15 意思是 10~56 都行；说「要 32 个铁」是说差不多够用。",
  "  顺着矿洞和地形走，比死磕坐标强 —— 别为了凑数字原地转圈。",
  "- **顺手原则**：路上遇到值钱的东西，先判断三件事 —— ① 我现在的镐子挖得动吗 ② 这东西我还缺吗 ③ 值不值得绕路。",
  "  缺 + 挖得动 → 就地解决；挖不动或者早就够了 → 记个坐标走人，别耽误主线。",
  "- **够了就别囤**：铁攒到一组多、木头几组就够日常了。囤过头是浪费时间，不如提议干点别的（盖房、下界、找乐子）。",
  "- **上限只是「值不值得特意去弄」的参考，不是任务清单**：永远只建议、不催促。",
  "  他说不想弄、或者正忙着，就别再提这件事；他要是想囤，你陪着就是了，别当管家。",
].join("\n");

export interface GuideStage {
  id: string;
  /** 中文短标题，用来汇报进度。 */
  title: string;
  /** 他是否已经过了这一步（近似判断：只看机器人的背包 + 维度）。 */
  done(state: GameState): boolean;
  /** 这一步该干什么 —— 直接说给玩家听的那种。 */
  hint: string;
  /** 机器人自己能用什么手段帮上忙（会写进大脑的提示）。 */
  actions: string;
}

/**
 * 附近（16 格内）有没有这个设施。
 * 用途：世界里已经摆着的东西，别再让模型去做一份 —— 用户原话
 * 「游戏环境中有工作台还要造」，根子就是进度只认背包、不认环境。
 */
export function nearStation(s: GameState, name: string): boolean {
  return (s.nearStations ?? []).some((st) => st.name === name);
}

export const STAGES: GuideStage[] = [
  {
    id: "wood",
    title: "撸树开局",
    done: (s) => count(s, (n) => /(_log|_wood|_stem|_hyphae)$/.test(n)) > 0,
    hint: "先徒手撸几棵树，弄 8~10 个原木。",
    actions: "run_skill chop_tree；set_goal {kind:'collect', item:'oak_log', count:16}",
  },
  {
    id: "bench",
    title: "工作台 + 木工具",
    done: (s) =>
      has(s, "crafting_table") ||
      // 世界里摆着的也算 —— 别再做第二个
      nearStation(s, "crafting_table") ||
      hasMatch(s, /^wooden_(pickaxe|axe|sword)$/),
    hint: "4 个木板做工作台（**周围已经有工作台就直接拿去用，别再做**），然后木镐 + 木斧 + 木剑。",
    actions: "craft_item（planks / crafting_table / wooden_pickaxe…）",
  },
  {
    id: "stone",
    title: "石头一代",
    done: (s) => hasMatch(s, /^stone_(pickaxe|sword|axe)$/) || has(s, "furnace"),
    hint: "挖 20 个石头，换石镐/石剑/石斧，再做个熔炉。",
    actions: "find_blocks {name:'any_stone'}；run_skill mine_vein；craft_item furnace",
  },
  {
    id: "light",
    title: "火把与照明",
    done: (s) => hasAny(s, ["coal", "charcoal", "torch"]),
    hint: "找煤（或烧木头做木炭）做火把 —— 天黑前把洞里点亮，不然一直刷怪。",
    actions: "find_blocks {name:'coal_ore'}；craft_item torch",
  },
  {
    id: "iron",
    title: "铁器时代",
    done: (s) => hasAny(s, ["iron_ingot", "raw_iron", "iron_pickaxe", "iron_sword"]),
    hint: "挖铁（y≈15~56），熔炉烧成铁锭，先做铁镐和铁剑，有条件再来个盾。",
    actions: "set_goal {kind:'collect', item:'raw_iron', count:8}；craft_item iron_pickaxe",
  },
  {
    id: "diamond",
    title: "钻石",
    done: (s) => hasAny(s, ["diamond", "diamond_pickaxe"]),
    hint: "往深处挖到 y≈-59 找钻石，带水桶防岩浆，至少做一把钻石镐。",
    actions: "set_goal {kind:'collect', item:'diamond', count:3}；run_skill mine_vein {ore:'diamond_ore'}",
  },
  {
    id: "nether",
    title: "下界之门",
    done: (s) => s.self.dimension === "the_nether" || count(s, (n) => n === "obsidian") >= 10,
    hint: "攒 10 个黑曜石（水浇岩浆）+ 打火石，开下界传送门。",
    actions: "find_blocks {name:'lava'}；place_block；craft_item flint_and_steel",
  },
  {
    id: "fortress",
    title: "下界要塞",
    done: (s) => hasAny(s, ["blaze_rod", "blaze_powder", "netherite_scrap"]),
    hint: "在下界找要塞，打烈焰人拿烈焰棒；顺手挖点远古残骸做下界合金。",
    actions: "run_skill explore_for {target:'chest'}；run_skill combat_assist；set_goal {kind:'collect', item:'blaze_rod', count:6}",
  },
  {
    id: "stronghold",
    title: "末影之眼与要塞",
    done: (s) => hasAny(s, ["ender_eye", "ender_pearl"]) || s.self.dimension === "the_end",
    hint: "末影珍珠 + 烈焰粉做成末影之眼，扔出去跟着走，找到要塞。",
    actions: "craft_item ender_eye；run_skill explore_for",
  },
  {
    id: "dragon",
    title: "末地 · 末影龙",
    done: (s) => s.self.dimension === "the_end",
    hint: "进末地：先炸水晶，再打龙。带足方块和食物，别掉虚空。",
    actions: "run_skill combat_assist；run_skill build_helper",
  },
];

/** 当前在第几步（第一件还没做完的事），以及下一步。 */
export function guideProgress(state: GameState): {
  index: number;
  stage: GuideStage;
  next?: GuideStage;
  doneCount: number;
} {
  const doneFlags = STAGES.map((stage) => {
    try {
      return stage.done(state);
    } catch {
      return false;
    }
  });
  const doneCount = doneFlags.filter(Boolean).length;
  const firstUndone = doneFlags.findIndex((d) => !d);
  if (firstUndone === -1) {
    const last = STAGES[STAGES.length - 1]!;
    return { index: STAGES.length - 1, stage: last, doneCount };
  }

  // 别拿"第一件还没做的事"当结论：背包里今天没有原木，不代表还在开局。
  // 取"第一个没做"和"已经做到的最后一步 + 1"里更靠后的那个 ——
  // 后期玩家（拿着钻石镐）就不会被告知"先去撸树"。
  let highestDone = -1;
  doneFlags.forEach((doneFlag, i) => {
    if (doneFlag) highestDone = i;
  });
  const index = Math.min(Math.max(firstUndone, highestDone + 1), STAGES.length - 1);
  return { index, stage: STAGES[index]!, next: STAGES[index + 1], doneCount };
}

/** `#guide` 打出去的那句话（确定性，不花 token）。 */
export function guideStatus(state: GameState): string {
  const { stage, next, index, doneCount } = guideProgress(state);
  const progress = `进度 ${doneCount}/${STAGES.length}`;
  if (doneCount === STAGES.length) {
    return `${progress} —— 主线全通了，兄弟你是真狠人。剩下的随便玩：刷装备、盖基地、找蘑菇岛。`;
  }
  return (
    `${progress} · 现在第 ${index + 1} 步「${stage.title}」：${stage.hint}` +
    (next ? `（下一步：${next.title}）` : "")
  );
}

/** 向导模式下，塞给大脑的一段"他现在在哪一步"。 */
export function guideBriefing(state: GameState): string {
  const { stage, next, index, doneCount } = guideProgress(state);
  return [
    "【向导模式】他现在的进度：" + doneCount + "/" + STAGES.length + "，卡在第 " + (index + 1) + " 步「" + stage.title + "」。",
    "这一步该干嘛：" + stage.hint,
    "你能用的手段：" + stage.actions,
    next ? "做完这步就进「" + next.title + "」。" : "这是最后一步。",
    "注意：进度是看**你的背包**推的，不一定等于他的。不确定就直接问一句，别硬指挥。",
    "他要是问别的（不想走主线、想盖房子），就顺着他的意思 —— 你是搭子，不是教官。",
    valueReport(state),
    "提示归提示，**数字是区间不是死线**：他想绕路挖别的、或者压根不想推主线，就跟着他走。",
  ].join("\n");
}
