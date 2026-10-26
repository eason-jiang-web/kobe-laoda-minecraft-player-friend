/**
 * 边玩边学：**他的习惯** + **你的熟练度**。
 *
 * 两块来源：
 *   1. 身体自动记账（不花模型钱）：他打了哪些 #指令、话多长、几点在线；
 *      每个任务成没成 —— 直接落在熟练度上。
 *   2. 大脑自己写（note_experience）：教训、偏好这种只有当事人才知道的。
 *
 * 为什么值得做：同一个存档玩久了，"他喜欢挖矿不喜欢下矿洞""晚上别在平原乱走"
 * 这种信息比任何攻略都值钱，而模型每次都是新开的，不写下来就永远从零开始。
 *
 * 全是纯函数 —— 存盘在 mc-bot，摘要进提示词。
 */
import { activityLabel, type PlayerActivity } from "./activity.js";

export interface HabitCount {
  /** 见 HABIT 里那几个构造函数。 */
  key: string;
  n: number;
  updatedAt: number;
}

export interface AdaptCount {
  area: string;
  attempts: number;
  successes: number;
  updatedAt: number;
}

export interface Lesson {
  area: string;
  text: string;
  at: number;
}

export interface PlayerProfile {
  habits: HabitCount[];
  adaptation: AdaptCount[];
  lessons: Lesson[];
}

/** 会记账的本事。加一个就得有个地方真的记它，别摆着好看。 */
export const SKILL_AREAS = [
  { id: "mining", label: "挖矿" },
  { id: "gathering", label: "采集" },
  { id: "combat", label: "打架" },
  { id: "building", label: "盖东西" },
  { id: "exploring", label: "探路" },
  { id: "farming", label: "种地" },
  { id: "crafting", label: "合成" },
  { id: "navigation", label: "认路" },
] as const;

/**
 * 两个不算本事的"笔记区"：他的偏好、通用教训。
 * 它们不进熟练度表（没有成败可言），但一样要记下来喂回提示词。
 */
export const NOTE_AREAS = [
  { id: "preference", label: "他的偏好" },
  { id: "lesson", label: "通用教训" },
] as const;

export const AREAS = [...SKILL_AREAS, ...NOTE_AREAS] as const;

export function areaLabel(id: string): string {
  const hit = AREAS.find((a) => a.id === id);
  return hit ? hit.label : id;
}

export function isSkillArea(id: string): boolean {
  return SKILL_AREAS.some((a) => a.id === id);
}

/**
 * 0-10 的熟练度。样本少的时候别吹 —— 用 (成功 + 2) / (尝试 + 4) 的平滑：
 * 5 次全成是 8 分不是满分，0 次尝试是中性 5 分。见得多了才敢说"擅长"。
 */
export function proficiency(line: AdaptCount): number {
  const attempts = Math.max(0, line.attempts);
  const successes = Math.max(0, Math.min(attempts, line.successes));
  return Math.round((10 * (successes + 2)) / (attempts + 4));
}

/**
 * 一个任务算哪门子本事 —— 只能记**真干过**的，认不出来就返回 null（宁可不记）。
 * 砍树单算「采集」，因为天天砍树和天天挖矿练的根本不是一回事。
 */
const SKILL_BY_NAME: Record<string, string> = {
  mine_vein: "mining",
  mine: "mining",
  mine_block: "mining",
  chop_tree: "gathering",
  gather: "gathering",
  combat_assist: "combat",
  fight: "combat",
  attack: "combat",
  hunt: "combat",
  build: "building",
  build_shelter: "building",
  place_block: "building",
  explore_for: "exploring",
  scout_ahead: "exploring",
  farm: "farming",
  harvest: "farming",
  plant: "farming",
  craft: "crafting",
  craft_item: "crafting",
  fetch_item: "navigation",
  go_to: "navigation",
  deliver: "navigation",
  come: "navigation",
};

export function areaForGoal(kind: string, skillName?: string, item?: string): string | null {
  if (skillName && SKILL_BY_NAME[skillName]) return SKILL_BY_NAME[skillName]!;
  if (kind === "collect") {
    const it = (item ?? "").toLowerCase();
    if (/_(log|wood|stem|hyphae)$/.test(it)) return "gathering";
    if (/(ore|diamond|emerald|redstone|lapis|coal|quartz|debris|netherite|raw_iron|raw_gold|raw_copper)/.test(it)) {
      return "mining";
    }
    return null;
  }
  if (kind === "deliver") return "navigation";
  if (kind === "skill") return skillName ? (SKILL_BY_NAME[skillName] ?? null) : null;
  return null;
}

// ── 自动记账的键 ──────────────────────────────────────────────────────────

export const HABIT = {
  /** 他打了哪条硬指令：#back / #free ... */
  command: (trigger: string) => "cmd:" + trigger,
  /** 他几点在线（本地小时）。 */
  hour: (hour: number) => "hour:" + hour,
  /** 他说了几句话。 */
  chat: "chat",
  /** 他说的话加起来多少字（配合 chat 算平均长度）。 */
  chatChars: "chatchars",
  /** 他叫了你几次名字。 */
  wake: "wake",
  /** 你问了他几次问题（问太多会变成审讯室，这个数字要能看见）。 */
  asked: "asked",
  /** 他常干什么活（挖矿 / 砍树 / 盖东西…）—— 学他的动作就靠这个。 */
  activity: (kind: string) => "act:" + kind,
} as const;

export interface HabitSummary {
  commands: Array<{ trigger: string; n: number }>;
  hours: Array<{ hour: number; n: number }>;
  /** 他常干的活（按次数）。 */
  activities: Array<{ kind: string; n: number }>;
  chatLines: number;
  avgChars: number;
  asked: number;
}

export function summarizeHabits(habits: HabitCount[]): HabitSummary {
  const commands: Array<{ trigger: string; n: number }> = [];
  const hours: Array<{ hour: number; n: number }> = [];
  const activities: Array<{ kind: string; n: number }> = [];
  let chatLines = 0;
  let chatChars = 0;
  let asked = 0;

  for (const h of habits) {
    if (h.key.startsWith("cmd:")) commands.push({ trigger: h.key.slice(4), n: h.n });
    else if (h.key.startsWith("hour:")) {
      const hour = Number(h.key.slice(5));
      if (Number.isFinite(hour)) hours.push({ hour, n: h.n });
    } else if (h.key === HABIT.chat) chatLines = h.n;
    else if (h.key === HABIT.chatChars) chatChars = h.n;
    else if (h.key === HABIT.asked) asked = h.n;
    else if (h.key.startsWith("act:")) activities.push({ kind: h.key.slice(4), n: h.n });
  }

  const desc = (a: { n: number }, b: { n: number }) => b.n - a.n;
  return {
    commands: commands.sort(desc).slice(0, 3),
    hours: hours.sort(desc).slice(0, 3).sort((a, b) => a.hour - b.hour),
    activities: activities.sort(desc).slice(0, 3),
    chatLines,
    avgChars: chatLines > 0 ? Math.round(chatChars / chatLines) : 0,
    asked,
  };
}

/** 「几点到几点」压缩成好看的一行（相邻小时合并成区间）。 */
function hourRanges(hours: Array<{ hour: number; n: number }>): string {
  if (hours.length === 0) return "";
  const nums = hours.map((h) => h.hour).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = nums[0]!;
  let prev = start;
  for (const h of nums.slice(1)) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    parts.push(start === prev ? start + "点" : start + "-" + prev + "点");
    start = h;
    prev = h;
  }
  parts.push(start === prev ? start + "点" : start + "-" + prev + "点");
  return parts.join("、");
}

/** 习惯那一段（给提示词和 #profile 共用）。 */
export function habitLine(summary: HabitSummary): string {
  const bits: string[] = [];
  if (summary.commands.length > 0) {
    bits.push("常打 " + summary.commands.map((c) => c.trigger + "(" + c.n + ")").join("、"));
  }
  if (summary.chatLines > 0) {
    const a = summary.avgChars;
    const style = a <= 8 ? "说话很短（平均 " + a + " 字）" : a <= 25 ? "说话正常（平均 " + a + " 字）" : "话比较多（平均 " + a + " 字）";
    bits.push(style);
  }
  if (summary.activities.length > 0) {
    // 学他的动作：他常干什么，它就偏向干什么
    bits.push("常干 " + summary.activities.map((a) => activityLabel(a.kind as PlayerActivity)).join("、"));
  }
  const hours = hourRanges(summary.hours);
  if (hours.length > 0) bits.push("常在 " + hours + " 出现");
  if (summary.asked > 0) bits.push("你问过他 " + summary.asked + " 次问题");
  return bits.join("；");
}

/**
 * 熟练度那一行。只列**真的试过**的本事 —— 没干过的写上去就是吹牛。
 */
export function skillLine(adaptation: AdaptCount[]): string {
  const tried = adaptation
    .filter((a) => isSkillArea(a.area) && a.attempts > 0)
    .sort((x, y) => proficiency(y) - proficiency(x));
  if (tried.length === 0) return "";
  return tried
    .map((a) => areaLabel(a.area) + " " + proficiency(a) + "（" + a.successes + "/" + a.attempts + "）")
    .join("｜");
}

/** 教训/偏好（去重，新的在前）。 */
export function recentLessons(lessons: Lesson[], max = 6): Lesson[] {
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const l of [...lessons].sort((a, b) => b.at - a.at)) {
    const key = l.text.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 塞进系统提示词的那段。刻意短（几百字）：它是**每回合都要付钱**的稳定前缀，
 * 所以只放"会改变决策"的东西，流水账留给 itto://profile/current。
 */
export function profileDigest(p: PlayerProfile, maxLessons = 6): string {
  const line = habitLine(summarizeHabits(p.habits));
  const skills = skillLine(p.adaptation);
  const lessons = recentLessons(p.lessons, maxLessons);
  if (line.length === 0 && skills.length === 0 && lessons.length === 0) return "";

  const out = ["## 关于这个兄弟，你自己攒下来的经验（越玩越准，做判断时用上）"];
  if (line.length > 0) out.push("他的习惯：" + line);
  if (skills.length > 0) out.push("你的熟练度（0-10，按真实成败算，别吹）：" + skills);
  const prefs = lessons.filter((l) => l.area === "preference");
  const others = lessons.filter((l) => l.area !== "preference");
  if (prefs.length > 0) out.push("他喜欢/不喜欢：" + prefs.map((l) => l.text).join("；"));
  if (others.length > 0) {
    out.push("教训（别犯第二次）：");
    for (const l of others) out.push("  · " + l.text + (l.area === "lesson" ? "" : "（" + areaLabel(l.area) + "）"));
  }
  return out.join("\n");
}

/** 游戏里 #profile 那一句（聊天栏上限 256，所以卡在 230 以内）。 */
export function profileBrief(p: PlayerProfile, maxChars = 230): string {
  const summary = summarizeHabits(p.habits);
  const bits: string[] = [];
  const skills = p.adaptation.filter((a) => isSkillArea(a.area) && a.attempts > 0);
  if (skills.length > 0) {
    bits.push(
      skills
        .sort((a, b) => proficiency(b) - proficiency(a))
        .map((a) => areaLabel(a.area) + proficiency(a) + "(" + a.successes + "/" + a.attempts + ")")
        .join(" "),
    );
  }
  const habit = habitLine(summary);
  if (habit.length > 0) bits.push(habit);
  const lessons = recentLessons(p.lessons, 3);
  if (lessons.length > 0) bits.push("记着 " + lessons.length + " 条教训");
  if (bits.length === 0) return "还没玩出什么名堂 —— 多带我干点活，我就记住了。";
  const text = bits.join("｜");
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}
