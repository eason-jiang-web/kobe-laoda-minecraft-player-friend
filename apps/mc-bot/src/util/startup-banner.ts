/**
 * 启动时打在终端里的"说明书"。
 *
 * 三个目的：
 *   1. 全部硬命令 + **每条命令的完整用法** —— 逐字从 COMMANDS 表生成，
 *      加一条命令这里自动就有，永远不会"文档写了终端没写"。
 *   2. 游戏里要做的唯一一步（/op）—— 它不在 .env 里，最容易忘，
 *      忘了的表现还像 bug（#back 说"传不过去"、远路全靠走）。
 *   3. 告诉玩家：说话就行，不用背指令。
 *
 * 纯函数，好在测试里断言内容。
 */

export interface BannerCommand {
  /** "#back" 这种字面量。没有就退化成整行 help（外部表兼容用）。 */
  trigger?: string;
  /** 一句话说明。 */
  help: string;
  /** 命令后面可以带一个参数。 */
  acceptsArg?: boolean;
  /** 详细用法，逐行打印。 */
  detail?: string[];
}

/** 命令列对齐宽度（中文按 2 格算太麻烦，直接给宽一点）。 */
const COL = 24;

/**
 * help 是给游戏里 `#help` 一行速查用的，自带 "#back —— " 前缀；
 * 终端已经有独立的"用法"列了，把前缀切掉免得同一行出现两次 #back。
 */
function stripPrefix(help: string, trigger: string): string {
  const sep = help.indexOf(" —— ");
  if (sep < 0) return help;
  const head = help.slice(0, sep);
  if (!head.startsWith(trigger)) return help;
  return help.slice(sep + 4);
}

/**
 * 一条命令在终端里的样子。
 *
 * 分工是这样的（很重要，不然会读成结巴）：
 *   `help`   —— **游戏里** `#help` 那行速查用的（一行，带 "#back —— " 前缀）
 *   `detail` —— **终端/说明书窗口**用的完整用法（几行，出口和坑都在这儿）
 * 所以有 detail 就只打 detail，不再把 help 复述一遍。
 */
function commandBlock(c: BannerCommand): string[] {
  if (!c.trigger) return ["   · " + c.help];

  const usage = c.trigger + (c.acceptsArg ? " <参数>" : "");
  const pad = usage.length >= COL ? " " : " ".repeat(COL - usage.length);
  const detail = c.detail ?? [];

  if (detail.length === 0) return ["   " + usage + pad + stripPrefix(c.help, c.trigger)];

  const out = ["   " + usage.padEnd(0) + " ".repeat(pad.length) + detail[0]!];
  for (const line of detail.slice(1)) out.push("   " + " ".repeat(COL) + line);
  return out;
}

const RULE = "  ──────────────────────────────────────────────────────────";

/** 机器人要连的地址（默认和 .env 的默认值一致）。 */
export interface Endpoint {
  host?: string;
  port?: number;
}

/**
 * 大脑状态。关着的时候机器人一句话都不说，所以终端必须明说 ——
 * 见 brainLines() 上面那段注释。
 */
export interface BrainStatus {
  enabled: boolean;
  /** BRAIN_CMD 拼回来的字符串；空 = 没配。 */
  cmd?: string;
}

/**
 * 端口这一条必须反复说 —— 游戏里「对局域网开放」给的端口**默认是随机的**，
 * 大多数人直接点确定，于是机器人怎么都连不上，看起来还像代码坏了。
 * 所以说明书窗口、启动横幅、以及每次连接失败，都用同一份文案提醒。
 */
export function portLine(host: string, port: number): string {
  return (
    "在游戏里「对局域网开放」时，端口填 " +
    port +
    "（游戏默认给的是随机的，得手动改）—— 我连的是 " +
    host +
    ":" +
    port
  );
}

function endpointLines(host: string, port: number): string[] {
  return [
    "   ★ 开局域网时的端口：填 " + port + "（游戏默认是随机的，必须手动改）",
    "     填错了我就一直连不上 —— 我会一直在那儿等，改好它自己就进来了。",
    "     （我连的是 " + host + ":" + port + "，想换端口就改 .env 里的 MC_SERVER_PORT）",
  ];
}

/**
 * 大脑那一行。为什么值得单独占两行：BRAIN_ENABLED 不是 true 的时候，机器人
 * 照样上线、照样跟着你、照样听 #指令，只是一句话都不说 —— 看起来完全像坏了。
 * 实测就是这样踩的：默认关着，照文档配完 doctor 全绿，进游戏喊它却没反应。
 */
function brainLines(brain?: BrainStatus): string[] {
  if (!brain) return [];
  const cmd = (brain.cmd ?? "").trim();
  if (!brain.enabled) {
    return [
      "   ★ 大脑：关着 —— 他只会执行上面的 #指令、跟着你走，不会跟你说话。",
      "     想让他开口：.env 里写 BRAIN_ENABLED=true，BRAIN_CMD=bun apps/brain-deepseek/src/index.ts",
      "",
    ];
  }
  if (cmd.length === 0) {
    return [
      "   ★ 大脑：BRAIN_ENABLED 开着，但 BRAIN_CMD 是空的 —— 等于没开，他还是不说话。",
      "     .env 里补上：BRAIN_CMD=bun apps/brain-deepseek/src/index.ts",
      "",
    ];
  }
  return ["   ★ 大脑：" + cmd + " —— 说人话他听得懂。", ""];
}

/**
 * 「它会自己救命」—— 横幅和说明书窗口共用。
 * 这些是**身体自己做的**（不用你发指令），写出来是为了让你知道它卡住时在忙什么，
 * 而不是以为它坏了。/follow play 那种要你发一句的，在命令表里。
 */
function selfHelpBlock(): string[] {
  return [
    "   它卡住的时候会自己想办法（不用你管）：",
    "     · 树顶够不着   → 先跳 → 钻进树干 → 垫方块往上爬",
    "     · 矿洞太黑     → 自己插火把（每挖 6 格看一次，够亮就不浪费）",
    "     · 目标在墙后   → 把挡路的那两格挖穿",
    "     · 卡住走不动   → 蹦一下 + 挖开身边的方块",
    "     每一步都会确认真的做到了才继续（垫了没上去、火把没插亮，都算失败）。",
  ];
}

/** 「说人话也行」—— 横幅和说明书窗口共用同一份。 */
function plainTalkBlock(): string[] {
  return [
    "   不想背指令？直接用中文跟他说就行，效果一样：",
    "     「去帮我挖点铁」「跟着我」「给我 32 个木头」「那边有个村庄」",
    "     「别打那只牛」「这附近有钻石吗」「我快死了救命」",
  ];
}

/** /op 那段 —— 两处共用，措辞只在这里写一次。 */
function opBlock(username: string): string[] {
  return [
    "   ★ 想让他瞬移（#back / 超过 30 格抄近路），二选一：",
    "     ① 在游戏里打一次  /op " + username,
    "     ② 退到标题画面（世界关掉），双击仓库里的「给牢大开权限.cmd」",
    "     不做也能玩 —— 跟随 / 挖矿 / 打怪 / 任务 / 对话全都正常，",
    "     只是远路他会自己走过去（慢一点，可能被地形卡住）。",
  ];
}

export function startupBanner(
  username: string,
  owner: string,
  commands: BannerCommand[],
  endpoint: Endpoint = {},
  brain?: BrainStatus,
): string[] {
  return [
    "",
    RULE,
    "   " + username + " 上线了。下面是全部硬命令 —— 直接打在游戏聊天框里，",
    "   不走大脑，瞬间生效。只有 " + owner + " 能触发（别人打没用）。",
    "",
    ...commands.flatMap(commandBlock),
    "",
    RULE,
    ...brainLines(brain),
    ...plainTalkBlock(),
    ...selfHelpBlock(),
    "",
    ...opBlock(username),
    "",
    ...endpointLines(endpoint.host ?? "127.0.0.1", endpoint.port ?? 25565),
    RULE,
    "",
  ];
}

/**
 * 单独弹一个"说明书窗口"时打的东西（菜单按 1 会顺带开，按 3 单独开）。
 *
 * 和启动横幅是**同一张命令表**渲染出来的 —— 加一条命令，两个窗口一起更新。
 * 区别只在于这里的顺序是"先提醒 /op，再列命令"，因为玩家开这个窗口就是为了查。
 */
export function cheatSheet(
  username: string,
  owner: string,
  commands: BannerCommand[],
  endpoint: Endpoint = {},
  brain?: BrainStatus,
): string[] {
  return [
    "",
    RULE,
    "   牢大 · 指令表",
    "   （这个窗口可以一直开着，关掉不影响他 —— 想再打开：菜单按 3）",
    RULE,
    "",
    "   ★ 第一步：在游戏里「对局域网开放」——",
    "",
    ...endpointLines(endpoint.host ?? "127.0.0.1", endpoint.port ?? 25565),
    "",
    RULE,
    "   ★ 第二步：在游戏聊天栏里打这一条（只需要一次）：",
    "",
    "        /op " + username,
    "",
    "     打了它就能瞬移过来（#back、超过 30 格抄近路）、能用服务器指令。",
    "     它自己也会确认：够用就什么都不说，不够用会在游戏里提醒你。",
    "     懒得打也行 —— 退到标题画面，双击「给牢大开权限.cmd」，一个字都不用打。",
    "",
    RULE,
    "   下面这些直接打在游戏聊天框里 —— 不走大脑，瞬间生效（只有 " + owner + " 能触发）：",
    "",
    ...commands.flatMap(commandBlock),
    "",
    RULE,
    ...brainLines(brain),
    ...plainTalkBlock(),
    ...selfHelpBlock(),
    RULE,
    "",
    "   （本窗口由「指令说明.cmd」打开；命令表变了它自动跟着变。）",
    "",
  ];
}
