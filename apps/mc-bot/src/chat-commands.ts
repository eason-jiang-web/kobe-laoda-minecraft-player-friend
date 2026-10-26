/**
 * Chat commands —— "别废话，直接干" 通道。
 *
 * 有些事不该等一个模型回合："#back" 的意思就是"现在、立刻、到我这儿来"。
 * 这类命令在身体里直接执行：**瞬间响应、永远一样、不花 token、不依赖大脑心情**。
 * 其他所有话都是聊天，照旧交给大脑。
 *
 * 加新命令就往 COMMANDS 里塞一条，规则：短、祈使句、重复执行也安全。
 */
import type { BotController } from "./bot/controller.js";
import { pickWeapon } from "./skills/combat-assist.js";
import { appendLabel } from "./training-labels.js";
import {
  activityLabel,
  countFor,
  groupLabel,
  guessPlayerActivity,
  guideProgress,
  guideStatus,
  itemDetail,
  needsSummary,
  readyFacilities,
  representativeItem,
  skillForActivity,
  valueOneLiner,
} from "@itto/shared";
import { clearCap, knownKeys, resolveItemKey, setCap } from "./value-caps.js";
import { logger } from "./util/logger.js";

const log = logger("cmd");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CommandContext {
  control: BotController;
  /** 跟随状态机 —— 自由活动模式住在它里面。 */
  follow: { setFreeRoam(on: boolean): void; isFreeRoam(): boolean };
  /** 目标执行器：让 #stop / #cancel 能丢掉当前任务，并报出丢掉的是哪个。 */
  runner: { cancel(): void; currentGoal(): { label: string } | null };
  /** 排一个技能目标（#follow play 用）。返回目标名。 */
  setSkill?(name: string, args?: Record<string, unknown>): string;
  /** 边玩边学攒下来的画像（他的习惯 + 你的熟练度）一句话版。 */
  profile?: () => string;
}

export interface ChatCommand {
  /** 玩家要输入的字面量（小写、带 # 前缀）。 */
  trigger: string;
  /** 一句话说明。 */
  help: string;
  /** 命令后面还能带一个参数（#attack zombie）。 */
  acceptsArg?: boolean;
  /**
   * 详细用法（终端启动时逐行打出来）。约束、出口、坑都写在这儿 ——
   * 玩家在游戏里看不到终端，所以这是**唯一的完整说明书**。
   */
  detail?: string[];
  /** 返回要在游戏里回的那句话。 */
  run(ctx: CommandContext, arg: string): Promise<string>;
}

/** 中文叫法 → 游戏里的实体 id。生物名和玩家名都走 findEntities。 */
const ENTITY_ALIASES: Record<string, string> = {
  僵尸: "zombie", 小僵尸: "zombie",
  苦力怕: "creeper", 爬行者: "creeper", 爆炸怪: "creeper",
  骷髅: "skeleton", 小白: "skeleton", 凋灵骷髅: "wither_skeleton",
  蜘蛛: "spider", 洞穴蜘蛛: "cave_spider",
  末影人: "enderman", 安德: "enderman",
  女巫: "witch", 史莱姆: "slime", 岩浆怪: "magma_cube",
  溺尸: "drowned", 尸壳: "husk", 幻翼: "phantom", 恶魂: "ghast", 烈焰人: "blaze",
  猪: "pig", 牛: "cow", 羊: "sheep", 鸡: "chicken", 兔子: "rabbit",
  村民: "villager", 铁傀儡: "iron_golem", 狼: "wolf", 狗: "wolf", 猫: "cat", 豹猫: "ocelot",
  马: "horse", 猪灵: "piglin", 疣猪兽: "hoglin", 守卫者: "guardian", 潜影贝: "shulker",
};

/**
 * #attack <名字> —— 打指定的那个东西（怪或者玩家），打完/打不动了如实汇报。
 * 打的过程中随时 #stop 能叫停：停火一开，这个循环自己就退出了。
 */
async function fight(ctx: CommandContext, rawArg: string): Promise<string> {
  const raw = rawArg.trim();
  if (!raw) return "打谁？用 #attack <生物名|玩家名>，比如 #attack zombie、#attack eason";

  const key = raw.toLowerCase();
  const entityName = ENTITY_ALIASES[key] ?? key;

  const find = (radius: number) => ctx.control.findEntities([entityName], radius)[0];
  const target = find(48);
  if (!target) return `附近 48 格没看到「${raw}」`;

  const weapon = pickWeapon(ctx.control.getState().inventory);
  if (weapon) await ctx.control.equip(weapon).catch(() => undefined);

  const id = target.id;
  const deadline = Date.now() + 15_000;
  /** #stop bumps the order, which cancels this routine mid-fight. */
  const order = ctx.control.attackOrder();
  const holdingFire = ctx.control.isPacifist();
  let swings = 0;

  while (Date.now() < deadline) {
    if (ctx.control.attackOrder() !== order) {
      return `收到停手，${raw} 先放一马（已经打了 ${swings} 下）`;
    }
    const live = ctx.control.findEntities([entityName], 64).find((e) => e.id === id);
    if (!live) break; // 死了或者跑没了
    try {
      if (live.distance > 3) await ctx.control.moveTo(live.pos, { range: 2, sprint: true });
      await ctx.control.attackDirect(live.id);
      swings++;
    } catch {
      /* 目标移位/刚死 —— 下一轮再看 */
    }
    await sleep(500);
  }

  if (swings === 0) return `够不着「${raw}」`;
  const still = find(64);
  const tail = holdingFire ? "（我还在停火状态，想让我放开打就 #nonstop）" : "";
  return still
    ? `打了「${raw}」${swings} 下，它还没倒${tail}`
    : `「${raw}」收拾完了${tail}`;
}

export const COMMANDS: ChatCommand[] = [
  {
    trigger: "#back",
    detail: [
      "解除自由活动 + 立刻传送到你身边",
      "你在别的维度、或者离太远的时候，它也会想办法闪过去",
      "也是 #free / #stay 的出口",
    ],
    help: "#back —— 解除自由活动，并立刻传送到你身边",
    async run({ control, follow }) {
      follow.setFreeRoam(false);
      control.setFreeRoam(false);
      control.setHoldPosition(false); // #back also ends #stay
      try {
        log.debug("#back: " + (await control.teleportToPlayer()));
        return "到，兄弟。";
      } catch (e) {
        const why = (e as Error).message;
        log.warn("#back failed: " + why);
        return "传不过去：" + why;
      }
    },
  },
  {
    trigger: "#free",
    detail: [
      "自由活动期间：跟随和自动传送都停，它自己去玩",
      "出口：#back",
    ],
    help: "#free —— 自由活动：不跟着你，也不会传送过去（直到 #back）",
    async run({ control, follow }) {
      follow.setFreeRoam(true);
      control.setFreeRoam(true);
      control.setHoldPosition(false); // #free means "go play", not "stand here"
      return "行，我自己去转转。想我了打 #back。";
    },
  },
  {
    trigger: "#stop",
    detail: [
      "停火：不主动攻击任何生物，并停下手上的动作、取消当前任务",
      "出口只有一个：#nonstop（#attack 是直接命令，不会解除停火）",
    ],
    help: "#stop —— 停火：不再攻击任何生物（直到 #nonstop）",
    async run({ control, runner }) {
      control.setPacifist(true);
      control.cancelAttackOrders(); // cancel an in-flight #attack
      control.stop();
      runner.cancel();
      return "停手了，谁都不碰。想让我重新动手就打 #nonstop。";
    },
  },
  {
    trigger: "#nonstop",
    detail: [
      "解除停火，恢复见怪就打",
    ],
    help: "#nonstop —— 解除停火，恢复见怪就打",
    async run({ control }) {
      control.setPacifist(false);
      return "行，手放开了，见怪就打。";
    },
  },
  {
    trigger: "#attack",
    detail: [
      "去打你点名的目标：生物（zombie / 苦力怕 / 骷髅…）或玩家（eason）",
      "停火期间照样能动手（这是直接命令）；打的过程中 #stop 能叫停",
      "够不着/没看到会如实说，不会假装打了",
    ],
    help: "#attack <生物名|玩家名> —— 去打它（#attack zombie / #attack eason / #attack 苦力怕）",
    acceptsArg: true,
    async run(ctx, arg) {
      return fight(ctx, arg);
    },
  },
  {
    trigger: "#cancel",
    detail: [
      "取消当前任务 —— 只是不干了，不影响跟随、也不解除停火",
    ],
    help: "#cancel —— 取消当前任务（只是不干了，还能聊天、还会跟着你）",
    async run({ control, runner }) {
      const had = runner.currentGoal();
      runner.cancel();
      control.cancelAttackOrders();
      control.stop();
      return had ? `行，「${had.label}」不干了。` : "手上本来就没活儿。";
    },
  },
  {
    trigger: "#stay",
    detail: [
      "原地待命：别跟、别乱跑、别自己找活干，就在这儿等",
      "出口：#here（走过来）/ #back（传过去）/ #free（改成自由活动）",
    ],
    help: "#stay —— 原地待命：别跟、别乱跑、别干活，就在这儿等着",
    async run({ control, follow, runner }) {
      runner.cancel();
      control.cancelAttackOrders();
      control.stop();
      follow.setFreeRoam(true); // 不跟
      control.setFreeRoam(true); // 也不自动传送
      control.setHoldPosition(true); // 更不自己跑去玩
      return "行，我在这儿等你。想让我过去就打 #here（走过去）或者 #back（传过去）。";
    },
  },
  {
    trigger: "#here",
    detail: [
      "走到你身边 —— 自己走，不传送（不想让它凭空出现时用这个）",
    ],
    help: "#here —— 走到你身边（自己走，不传送）",
    async run({ control, follow }) {
      follow.setFreeRoam(false);
      control.setFreeRoam(false);
      control.setHoldPosition(false);
      const player = control.getState().player?.pos;
      if (!player) return "看不见你在哪（你在线上吗？）";
      void control.chat("来了，走着呢").catch(() => undefined);
      try {
        await control.moveTo(player, { range: 2, sprint: true, noTeleport: true });
        return "到了，兄弟。";
      } catch (e) {
        return `过不去：${(e as Error).message}`;
      }
    },
  },
  {
    trigger: "#quiet",
    detail: [
      "闭嘴模式：你不叫它，它就不主动说话",
      "危险提醒（苦力怕/低血量）和回你的话照常 —— 只关掉闲聊",
      "出口：#talk",
    ],
    help: "#quiet —— 闭嘴模式：你不叫它，它就不主动说话（#talk 解除）",
    async run({ control }) {
      control.setMuted(true);
      return "行，我安静。有事叫我。";
    },
  },
  {
    trigger: "#talk",
    detail: [
      "解除闭嘴，恢复主动聊天",
    ],
    help: "#talk —— 解除闭嘴，恢复主动聊天",
    async run({ control }) {
      control.setMuted(false);
      return "行，那我话又多起来了。";
    },
  },
  {
    trigger: "#value",
    detail: [
      "不带参数                        值钱的东西 + 还缺什么（一行看完）",
      "#value 铁                       看单件（价值分、用途、你的数量、上限）",
      "#value 铁 400                   把铁的上限改成 400（绝对总数，不乘人数）",
      "#value 铁 0                     不限量      #value 铁 默认   还原默认表",
      "改完存 data/value-caps.json，重启不丢；向导/自主玩/路过矿石的判断全都跟着变",
    ],
    help: "#value 看评估+还缺啥 · #value 铁 看单件 · #value 铁 400 把上限改成 400（0 = 不限量，默认 = 还原）",
    acceptsArg: true,
    async run({ control }, arg) {
      const state = control.getState();
      const parts = arg.trim().split(/\s+/).filter(Boolean);

      // #value —— 一行总览：值钱的 + 还缺什么（"我们还缺啥"就靠这条问）
      if (parts.length === 0) return valueOneLiner(state) + "｜" + needsSummary(state);

      const key = resolveItemKey(parts[0]!);
      if (!key) {
        return `不认识「${parts[0]}」。能写中文（铁 / 钻石 / 下界合金 / 木头…）或者物品 id；` +
          `现在能调的有：${knownKeys().join(" ")}`;
      }

      // #value 铁 —— 看它现在什么情况
      if (parts.length === 1) {
        const have = countFor(key, state);
        return itemDetail(representativeItem(key), have, state, groupLabel(key));
      }

      // #value 铁 默认 —— 还原成默认表
      if (parts[1] === "默认" || parts[1]!.toLowerCase() === "reset") {
        clearCap(key);
        const have = countFor(key, state);
        return (
          `行，${groupLabel(key)} 的上限还原成默认了。` +
          itemDetail(representativeItem(key), have, control.getState(), groupLabel(key))
        );
      }

      // #value 铁 400 —— 改上限（绝对总数）
      const n = Number(parts[1]);
      if (!Number.isFinite(n) || n < 0) {
        return `「${parts[1]}」不是个数字。用法：#value 铁 400（0 = 不限量）`;
      }
      setCap(key, n);
      const have = countFor(key, state);
      const detail = itemDetail(representativeItem(key), have, control.getState(), groupLabel(key));
      return n === 0
        ? `行，${groupLabel(key)} 不限量了。` + detail
        : `行，${groupLabel(key)} 的上限改成 ${Math.round(n)} 了。` + detail;
    },
  },
  {
    trigger: "#profile",
    help: "#profile —— 看我玩出来的经验（他的习惯 + 我的熟练度）",
    detail: [
      "看我这一路攒下来的经验：我的熟练度（挖矿/打架/盖东西…按真实成败算）",
      "加他的习惯（常打哪些指令、几点上线、说话长短）和记下的教训。",
      "数据存在 data/world.db，边玩边长 —— 换个存档是另一份。",
      "想让我少问问题也可以直接说「别问了，你自己看着办」。",
    ],
    run: async (ctx) => {
      // 纯读本地数据，不走大脑、不花钱、瞬间回。
      return ctx.profile?.() ?? "还没玩出什么名堂 —— 多带我干点活，我就记住了。";
    },
  },
  {
    trigger: "#follow play",
    help: "#follow play —— 看你正在干嘛，跟你干一样的活",
    detail: [
      "它看一眼你现在在干嘛，然后自己去干同类的活：",
      "  你在砍树 → 它也去砍树      你在挖矿 → 它也挖（挖你正对着的那种）",
      "  你在打架 → 它上来帮你        你在盖东西 → 它去帮你备料",
      "  看不出你在干嘛 → 它跟着你，让你补一句（「一起砍树」也行，只是走大脑慢一点）",
      "它判断的依据：你正对着的方块 > 你手上的工具 > 你旁边的怪。",
    ],
    run: async (ctx) => {
      const state = ctx.control.getState();
      const act = guessPlayerActivity(state);
      const job = skillForActivity(act);
      if (!job) {
        return "看不出你在干啥（" + act.why + "）—— 我跟着你了，说一句「一起砍树」或者「一起挖矿」也行。";
      }
      if (!ctx.setSkill) return "任务队列没接上（内部错误）";
      ctx.setSkill(job.name, job.args);
      return "跟你干一样的：" + activityLabel(act.kind) + "（" + act.why + "）";
    },
  },
  {
    trigger: "#guide",
    detail: [
      "mode          开工向导：带你走主线 10 步，主动报下一步",
      "不带参数      看进度 + 下一步 + 现在材料够盖什么（纯计算，秒回不花 token）",
      "off           下班",
      "进度是按它自己的背包 + 维度推的，不一定等于你的 —— 不确定它会问你",
    ],
    help: "#guide mode 开向导 · #guide off 关向导 · #guide 看进度和下一步",
    acceptsArg: true,
    async run({ control }, arg) {
      const mode = arg.trim().toLowerCase();
      if (mode === "" || mode === "status") {
        const state = control.getState();
        const base = guideStatus(state);
        // 顺手报一句"现在材料够盖什么"—— 他想盖房子/农场时最想知道的就是这个。
        const ready = readyFacilities(state);
        return ready.length > 0
          ? base + " · 现在材料够开工：" + ready.slice(0, 3).map((f) => f.name).join("、") + "（想盖就说一声）"
          : base;
      }
      if (mode === "mode" || mode === "on") {
        control.setGuide(true);
        const { stage } = guideProgress(control.getState());
        // 单行！Minecraft 聊天是一行，别把换行符塞进去
        return `向导模式开了 —— ${guideStatus(control.getState())}。盯这一步「${stage.title}」，你走你的，我在旁边报点。`;
      }
      if (mode === "off") {
        control.setGuide(false);
        return "行，向导下班。接下来你想咋玩咋玩。";
      }
      return "用法：#guide mode（开向导）/ #guide off（关）/ #guide（看进度）";
    },
  },
  {
    trigger: "#good",
    detail: [
      "给刚才那一轮点个赞 —— 写进训练数据（data/training/），以后用来调教它",
    ],
    help: "#good —— 给刚才那一轮点个赞（写进训练日志，方便以后调教）",
    async run() {
      try {
        appendLabel("good");
        return "收到，这波我自己也满意。";
      } catch (e) {
        log.warn("#good failed: " + (e as Error).message);
        return "记是记下了，就是没写进去（看看 data/training 能不能写）。";
      }
    },
  },
  {
    trigger: "#bad",
    detail: [
      "刚才那轮不行 —— 同样写进训练数据",
    ],
    help: "#bad —— 刚才那轮不行（写进训练日志，我会记着改）",
    async run() {
      try {
        appendLabel("bad");
        return "行，这波我拉胯了。记下了，下回不这么整。";
      } catch (e) {
        log.warn("#bad failed: " + (e as Error).message);
        return "记是记下了，就是没写进去（看看 data/training 能不能写）。";
      }
    },
  },
  {
    trigger: "#help",
    detail: [
      "在游戏里列一行速查（详细说明看终端启动时打的那段）",
    ],
    help: "#help —— 在游戏里列出所有硬命令（一行速查）",
    async run() {
      return COMMANDS.map((c) => c.trigger).join(" · ") + "；详细说明看终端启动时打的那一段";
    },
  },
];

export interface CommandMatch {
  command: ChatCommand;
  arg: string;
}

/** 整行匹配（命令可以带一个参数）。普通聊天返回 null。 */
export function matchCommand(message: string): CommandMatch | null {
  const text = message.trim();
  const lower = text.toLowerCase();
  for (const command of COMMANDS) {
    if (lower === command.trigger) return { command, arg: "" };
    if (command.acceptsArg && lower.startsWith(command.trigger + " ")) {
      return { command, arg: text.slice(command.trigger.length).trim() };
    }
  }
  return null;
}
