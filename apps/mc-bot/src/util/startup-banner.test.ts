import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../chat-commands.js";
import { cheatSheet, startupBanner } from "./startup-banner.js";

describe("startupBanner", () => {
  const lines = startupBanner("Laoda", "eason", COMMANDS);
  const text = lines.join("\n");

  test("lists EVERY hard command with its terminal description", () => {
    for (const command of COMMANDS) {
      expect(text).toContain(command.trigger);
      // 有 detail 就打 detail（终端=详细用法），没有才退回 help
      for (const line of command.detail ?? []) expect(text).toContain(line);
      if ((command.detail ?? []).length === 0) {
        const body = command.help.split(" —— ").slice(1).join(" —— ") || command.help;
        expect(text).toContain(body);
      }
    }
  });

  test("never prints two neighbouring lines that say the same thing", () => {
    // 曾经 help 和 detail[0] 会挨着打印两遍近乎相同的话 —— 读起来像结巴。
    // 直接冲着症状断言：相邻两行（去掉标点空格后）不能是同一句。
    const norm = (s: string) => s.replace(/[\s，。、：；+·—～()（）]/g, "");
    const flat = lines.map(norm);
    for (let i = 1; i < flat.length; i++) {
      if (flat[i] === "" || flat[i - 1] === "") continue;
      expect([flat[i - 1], flat[i]]).not.toEqual([flat[i], flat[i]]);
    }
  });

  test("tells you the one in-game setup step, with the bot's own name", () => {
    expect(text).toContain("/op Laoda");
    expect(text).toContain("不做也能玩");
  });

  test("says who can use them, and that plain Chinese still works", () => {
    expect(text).toContain("只有 eason 能触发");
    expect(text).toContain("直接用中文");
  });

  test("adds a command line automatically when the table grows", () => {
    const grown = startupBanner("Laoda", "eason", [...COMMANDS, { help: "#dance —— 跳个舞" }]);
    expect(grown.join("\n")).toContain("#dance");
  });

  test("prints EVERY command's detailed usage, not just the one-liner", () => {
    // 每条命令都得有 detail，否则说明书就是残缺的 —— 这是硬约束，不是建议。
    for (const command of COMMANDS) {
      expect(command.detail && command.detail.length, command.trigger).toBeGreaterThan(0);
      for (const line of command.detail ?? []) expect(text).toContain(line);
    }
    // 用法列 + 参数占位符
    expect(text).toContain("#attack <参数>");
    // 出口必须写清楚
    expect(text).toContain("#nonstop");
  });

  test("offers the no-typing op path too", () => {
    expect(text).toContain("给牢大开权限.cmd");
  });

  test("carries the LAN-port reminder too, with the configured port", () => {
    const custom = startupBanner("Laoda", "eason", COMMANDS, { host: "10.0.0.5", port: 25599 }).join("\n");
    expect(custom).toContain("端口：填 25599");
    expect(custom).toContain("10.0.0.5:25599");
  });
});

describe("cheatSheet — 菜单里那个单独的说明窗口", () => {
  const sheet = cheatSheet("Laoda", "eason", COMMANDS).join("\n");

  test("the /op reminder comes FIRST, before any command", () => {
    const opAt = sheet.indexOf("/op Laoda");
    const firstCommandAt = sheet.indexOf("#back");
    expect(opAt).toBeGreaterThan(-1);
    expect(opAt).toBeLessThan(firstCommandAt);
    expect(sheet).toContain("只需要一次");
  });

  test("lists every command with its full usage, same table as the banner", () => {
    for (const command of COMMANDS) {
      expect(sheet).toContain(command.trigger);
      for (const line of command.detail ?? []) expect(sheet).toContain(line);
    }
  });

  test("says who can use them and that plain Chinese works too", () => {
    expect(sheet).toContain("只有 eason 能触发");
    expect(sheet).toContain("直接用中文");
  });

  test("tells you the window is disposable and how to reopen it", () => {
    expect(sheet).toContain("关掉不影响");
    expect(sheet).toContain("菜单按 3"); // 菜单只有 1~5 和 0，别写成按 6
  });

  test("reminds you to set the LAN port — with the port the bot actually uses", () => {
    const custom = cheatSheet("Laoda", "eason", COMMANDS, { host: "127.0.0.1", port: 25570 }).join("\n");
    expect(custom).toContain("端口：填 25570");
    expect(custom).toContain("127.0.0.1:25570");
    expect(custom).toContain("默认是随机的"); // 说清为什么要手动改
    // 默认值也别忘了
    expect(cheatSheet("Laoda", "eason", COMMANDS).join("\n")).toContain("端口：填 25565");
  });

  test("说明书里写了「它会自己救命」—— 别让人以为它卡住就是坏了", () => {
    expect(sheet).toContain("自己想办法");
    expect(sheet).toContain("垫方块往上爬");
    expect(sheet).toContain("插火把");
    // 启动横幅里也有同一段
    expect(startupBanner("Laoda", "eason", COMMANDS).join("\n")).toContain("挖穿");
  });

  test("says it waits instead of dying when it can't get in", () => {
    expect(sheet).toContain("我会一直在那儿等");
  });
});

describe("大脑状态 —— 它不说话的原因必须写在脸上", () => {
  const CMD = "bun apps/brain-deepseek/src/index.ts";
  const off = startupBanner("Laoda", "eason", COMMANDS, {}, { enabled: false }).join("\n");
  const noCmd = startupBanner("Laoda", "eason", COMMANDS, {}, { enabled: true, cmd: "" }).join("\n");
  const on = startupBanner("Laoda", "eason", COMMANDS, {}, { enabled: true, cmd: CMD }).join("\n");

  test("关着的时候明说「不会跟你说话」，并把两行怎么改直接给出来", () => {
    expect(off).toContain("大脑：关着");
    expect(off).toContain("不会跟你说话");
    expect(off).toContain("BRAIN_ENABLED=true");
    expect(off).toContain("BRAIN_CMD=" + CMD);
  });

  test("开着但 BRAIN_CMD 空着也照样拦（半开等于没开）", () => {
    expect(noCmd).toContain("BRAIN_CMD 是空的");
    expect(noCmd).toContain("等于没开");
  });

  test("正常开着就说清楚现在是谁在说话", () => {
    expect(on).toContain("brain-deepseek");
    expect(on).not.toContain("大脑：关着");
  });

  test("不传大脑状态就一个字都不多打（老的调用点不受影响）", () => {
    expect(startupBanner("Laoda", "eason", COMMANDS).join("\n")).not.toContain("★ 大脑：");
  });

  test("说明书窗口也说同一件事", () => {
    const sheet = cheatSheet("Laoda", "eason", COMMANDS, {}, { enabled: false }).join("\n");
    expect(sheet).toContain("大脑：关着");
  });
});
