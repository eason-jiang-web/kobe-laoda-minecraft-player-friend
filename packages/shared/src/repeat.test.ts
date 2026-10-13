import { describe, expect, test } from "bun:test";
import {
  findRepeat,
  isOwnerEcho,
  normalizeLine,
  openerOf,
  rememberSaid,
  REPEAT_WINDOW_MS,
  repeatedOpener,
  similarity,
  type SaidLine,
} from "./repeat.js";

const T0 = 1_700_000_000_000;
const said = (text: string, at = T0): SaidLine => ({ text, at });

describe("normalizeLine", () => {
  test("空白、标点、大小写、emoji 都不影响判定", () => {
    expect(normalizeLine("砍树去了，不吭声。")).toBe(normalizeLine("砍树去了 不吭声"));
    expect(normalizeLine("OK man!")).toBe(normalizeLine("ok man"));
    expect(normalizeLine("走了 🎤")).toBe(normalizeLine("走了"));
  });
});

describe("similarity", () => {
  test("一模一样是 1", () => {
    expect(similarity("砍树去", "砍树去")).toBe(1);
  });

  test("只差一个语气词算很像", () => {
    expect(similarity("我这就去砍树", "我这就去砍树了")).toBeGreaterThan(0.85);
  });

  test("换个宾语就不该算像 —— 这是防误伤的关键", () => {
    // 「我去挖矿」和「我去砍树」意思完全不同，绝不能当同一句拦掉
    expect(similarity("好，我这就去挖矿", "好，我这就去砍树")).toBeLessThan(0.85);
    expect(similarity("那边有只苦力怕", "那边有只牛")).toBeLessThan(0.85);
  });

  test("空字符串不炸", () => {
    expect(similarity("", "砍树")).toBe(0);
    expect(similarity("a", "")).toBe(0);
  });
});

describe("findRepeat —— 真实踩过的那句话", () => {
  test("原样重说会被抓住", () => {
    const recent = [said("砍树任务还在跑，不吭声了。", T0)];
    expect(findRepeat("砍树任务还在跑，不吭声了。", recent, T0 + 60_000)).not.toBeNull();
  });

  test("换个标点/加个空格也算同一句", () => {
    const recent = [said("砍树任务还在跑，不吭声了。", T0)];
    expect(findRepeat("砍树任务还在跑 不吭声了", recent, T0 + 60_000)).not.toBeNull();
  });

  test("五分钟以后可以再说（不是一辈子禁言）", () => {
    const recent = [said("砍树任务还在跑，不吭声了。", T0)];
    expect(findRepeat("砍树任务还在跑，不吭声了。", recent, T0 + REPEAT_WINDOW_MS + 1)).toBeNull();
  });

  test("正常的新内容不会被误伤", () => {
    const recent = [said("好，我这就去挖矿", T0)];
    expect(findRepeat("等等，那边有只苦力怕", recent, T0 + 1000)).toBeNull();
    expect(findRepeat("好，我这就去砍树", recent, T0 + 1000)).toBeNull();
  });

  test("空话不拦（省得把「嗯」也堵死）", () => {
    const recent = [said("嗯", T0)];
    expect(findRepeat("嗯", recent, T0 + 1000)).not.toBeNull();
    expect(findRepeat("   ", recent, T0 + 1000)).toBeNull();
  });
});

describe("repeatedOpener —— 字面不同但形状一样的复读", () => {
  test("同一个开头用两次，第三次就要换", () => {
    const recent = [said("收到 man，木头凑到 8 根了"), said("收到 man，东北那两棵树我包了")];
    expect(repeatedOpener("收到 man，石头我这就去刨", recent, T0 + 1000)).not.toBeNull();
  });

  test("只出现一次不算腻", () => {
    const recent = [said("收到 man，木头凑到 8 根了")];
    expect(repeatedOpener("收到 man，石头我这就去刨", recent, T0 + 1000)).toBeNull();
  });

  test("换个开头就没事", () => {
    const recent = [said("收到 man，木头凑到 8 根了"), said("收到 man，东北那棵树我包了")];
    expect(repeatedOpener("行，那我去刨石头", recent, T0 + 1000)).toBeNull();
  });

  test("开场白怎么看：「收到 man，」归一化后取前四个字", () => {
    expect(openerOf("收到 man，木头")).toBe(openerOf("收到man 木头"));
    expect(openerOf("收到 man，木头")).not.toBe(openerOf("好嘞，木头"));
  });

  test("太短的开头（「嗯」「好」）不当开场白算", () => {
    const recent = [said("嗯"), said("嗯")];
    expect(repeatedOpener("嗯", recent, T0 + 1000)).toBeNull();
  });
});

describe("isOwnerEcho —— 他在催，不是让你再答一遍", () => {
  const prev = { text: "跟我垂直挖矿", at: T0 };

  test("同一句话 20 秒内再说 = 重复", () => {
    expect(isOwnerEcho(prev, "跟我垂直挖矿", T0 + 5000)).toBe(true);
    expect(isOwnerEcho(prev, "跟我垂直挖矿！", T0 + 5000)).toBe(true); // 标点不算
  });

  test("换了一句话就是新要求", () => {
    expect(isOwnerEcho(prev, "跟我去砍树", T0 + 5000)).toBe(false);
    expect(isOwnerEcho(prev, "把木头给我", T0 + 5000)).toBe(false);
  });

  test("隔了一会儿再说就重新算（他不是在催了）", () => {
    expect(isOwnerEcho(prev, "跟我垂直挖矿", T0 + 21_000)).toBe(false);
  });

  test("没说过话就不算", () => {
    expect(isOwnerEcho(null, "跟我垂直挖矿", T0)).toBe(false);
  });

  test("实测那一幕：36 秒里打了 8 遍同一句 → 只该处理一遍", () => {
    // 照主循环里的规矩走：他还在催，窗口就往后推（第一遍已经开工了）。
    // 那一幕一共触发了 45 次唤醒、45 句回复 —— 这里应该只剩 1 次。
    let last: { text: string; at: number } | null = null;
    let handled = 0;
    for (let i = 0; i < 8; i++) {
      const at = T0 + i * 4500;
      const echo = isOwnerEcho(last, "跟我垂直挖矿", at);
      last = { text: "跟我垂直挖矿", at }; // 处理还是催，都记一笔
      if (!echo) handled++;
    }
    expect(handled).toBe(1);
  });
});

describe("rememberSaid", () => {
  test("累加 + 过期自动丢", () => {
    let recent: SaidLine[] = [];
    recent = rememberSaid(recent, "第一句", T0);
    recent = rememberSaid(recent, "第二句", T0 + 1000);
    expect(recent.length).toBe(2);
    recent = rememberSaid(recent, "很久以后", T0 + REPEAT_WINDOW_MS + 5000);
    expect(recent.map((r) => r.text)).toEqual(["很久以后"]);
  });

  test("只留最近 keep 条", () => {
    let recent: SaidLine[] = [];
    for (let i = 0; i < 30; i++) recent = rememberSaid(recent, "第" + i + "句", T0 + i);
    expect(recent.length).toBe(20);
    expect(recent.at(-1)!.text).toBe("第29句");
  });
});
