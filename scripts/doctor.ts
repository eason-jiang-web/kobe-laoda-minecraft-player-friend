#!/usr/bin/env bun
/**
 * 上手自检 —— 配完跑一下，看哪儿还没对。
 *
 *   bun run doctor
 *
 * 为什么要有它：新人最常见的三个坑是"忘了建 .env""版本填错""世界没开局域网"，
 * 而它们的报错都很吓人（ECONNREFUSED、版本不支持）。这里挨个提前查一遍，
 * 用中文说清楚"下一步该干嘛"，而不是让人对着堆栈猜。
 *
 * 只读：不改任何文件、不发任何 Minecraft 指令（DeepSeek 那项会花掉一次极小的请求）。
 */
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
// 相对路径：doctor 是仓库级工具，不在任何 workspace 包的依赖图里。
// 被引的文件住在 apps/mc-bot 下，它们自己的 @itto/shared 依赖会从那边解析。
import { findMcRoot, findLanguageFile } from "../apps/mc-bot/src/util/zh-lang.js";
import { assertSupportedVersion } from "../apps/mc-bot/src/bot/versions.js";

interface Result {
  ok: boolean;
  /** 一句话结论。 */
  label: string;
  /** 不对时给的建议。 */
  fix?: string;
  /** 影响使用吗（可选功能失败不算致命）。 */
  fatal?: boolean;
}

const results: Result[] = [];
const add = (r: Result) => results.push(r);

/** 读 .env（不依赖框架：自己解析，键=值）。 */
function readEnvFile(): Record<string, string> {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").trim();
  }
  return out;
}

async function tcpReachable(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function deepseekWorks(key: string, baseUrl: string, model: string): Promise<string | null> {
  try {
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return null;
    const body = await res.text();
    return "HTTP " + res.status + " " + body.slice(0, 120);
  } catch (e) {
    return (e as Error).message.slice(0, 120);
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log("  ── 牢大 · 上手自检 ──────────────────────────────");
  console.log("");

  // 1. 运行时
  const bun = process.versions.bun;
  add(
    bun
      ? { ok: true, label: "Bun " + bun }
      : {
          ok: false,
          fatal: true,
          label: "没有跑在 Bun 上",
          fix: "装 Bun：https://bun.sh  （装完要开一个新终端）",
        },
  );

  // 2. .env
  const env = readEnvFile();
  const hasEnv = existsSync(join(process.cwd(), ".env"));
  add(
    hasEnv
      ? { ok: true, label: ".env 找到了" }
      : {
          ok: false,
          fatal: true,
          label: "没有 .env",
          fix: "把 .env.example 复制成 .env（PowerShell：Copy-Item .env.example .env），然后填下面几项",
        },
  );
  const get = (k: string) => env[k] ?? process.env[k] ?? "";

  // 3. 必填项
  const required: Array<[string, string]> = [
    ["DEEPSEEK_API_KEY", "DeepSeek 的 key（platform.deepseek.com 拿）"],
    ["MC_OWNER_USERNAME", "你的游戏名（机器人听谁的、跟着谁）"],
    ["MC_BOT_USERNAME", "机器人自己的游戏名（ASCII，3-16 位）"],
    ["MC_VERSION", "你世界的版本，比如 1.20.6（必须一字不差）"],
  ];
  for (const [key, why] of required) {
    const value = get(key);
    add(
      value.length > 0
        ? { ok: true, label: key + " 已填" }
        : { ok: false, fatal: true, label: key + " 没填", fix: "在 .env 里写上：" + why },
    );
  }

  // 4. 版本能不能跑
  const version = get("MC_VERSION");
  if (version.length > 0) {
    try {
      assertSupportedVersion(version);
      add({ ok: true, label: "mineflayer 认识版本 " + version });
    } catch (e) {
      add({ ok: false, fatal: true, label: "版本 " + version + " 跑不了", fix: (e as Error).message });
    }
  }

  // 5. 世界连不连得上
  const host = get("MC_SERVER_HOST") || "127.0.0.1";
  const port = Number(get("MC_SERVER_PORT") || 25565);
  const reachable = await tcpReachable(host, port);
  add(
    reachable
      ? { ok: true, label: "连得上 " + host + ":" + port }
      : {
          ok: false,
          label: "连不上 " + host + ":" + port,
          fix:
            "进游戏 → Esc → 对局域网开放 → **端口填 " + port + "**（游戏默认给的是随机的）。" +
            "机器人会一直等，但自检这一步过不去就是还没开。",
        },
  );

  // 6. DeepSeek key 真能用吗
  const key = get("DEEPSEEK_API_KEY");
  if (key.length > 0) {
    const err = await deepseekWorks(
      key,
      get("DEEPSEEK_BASE_URL") || "https://api.deepseek.com",
      get("DEEPSEEK_MODEL") || "deepseek-flash",
    );
    add(
      err === null
        ? { ok: true, label: "DeepSeek key 可用（模型 " + (get("DEEPSEEK_MODEL") || "deepseek-flash") + "）" }
        : { ok: false, fatal: true, label: "DeepSeek key 用不了", fix: err + "  —— 去 platform.deepseek.com 检查 key / 余额" },
    );
  }

  // 7. 大脑开没开 —— 关着的时候它一句话都不说，最容易看着像坏了
  if (hasEnv) {
    const brainOn = get("BRAIN_ENABLED") === "true";
    const brainCmd = get("BRAIN_CMD").trim();
    if (!brainOn) {
      add({
        ok: false,
        label: "大脑关着（BRAIN_ENABLED 不是 true）—— 它会进游戏、跟着你、听 #指令，但不会跟你说话",
        fix:
          "想让它回话就在 .env 里写 BRAIN_ENABLED=true 和 " +
          "BRAIN_CMD=bun apps/brain-deepseek/src/index.ts（.env.example 里默认就是这两行）",
      });
    } else if (brainCmd.length === 0) {
      add({
        ok: false,
        fatal: true,
        label: "BRAIN_ENABLED 开着，但 BRAIN_CMD 是空的 —— 等于没开",
        fix: "在 .env 里补上：BRAIN_CMD=bun apps/brain-deepseek/src/index.ts",
      });
    } else {
      add({ ok: true, label: "大脑开着（" + brainCmd + "）" });
    }
  }

  // 8. 中文物品名（找不到不影响玩）
  const appData = process.env.APPDATA;
  const mcRoot = findMcRoot(
    [get("MC_GAME_DIR"), appData ? join(appData, ".minecraft") : ""].filter((p) => p.length > 0),
  );
  const langFile = mcRoot ? findLanguageFile(mcRoot) : null;
  add(
    langFile
      ? { ok: true, label: "找到 Minecraft 中文语言文件（物品名会是中文）" }
      : {
          ok: false,
          label: "没找到 Minecraft 语言文件（物品名会用内置词典）",
          fix: "不影响玩。想显示官方中文名，就把 MC_GAME_DIR 指向你的游戏目录（PCL 版本隔离时是 ...\\.minecraft\\versions\\<版本>）",
        },
  );

  // 打印
  for (const r of results) {
    console.log("  " + (r.ok ? "✓" : r.fatal ? "✗" : "!") + " " + r.label);
    if (!r.ok && r.fix) console.log("      → " + r.fix);
  }

  const broken = results.filter((r) => !r.ok && r.fatal);
  const warnings = results.filter((r) => !r.ok && !r.fatal);
  console.log("");
  if (broken.length === 0 && warnings.length === 0) {
    console.log("  全绿。开局域网，然后：bun run bot");
    console.log("  （或者双击桌面「牢大」按 1，它会顺带开一个指令表窗口）");
    console.log("");
    process.exit(0);
  }
  if (broken.length > 0) {
    console.log("  还有 " + broken.length + " 项必须处理（上面标 ✗ 的），处理完再跑一次 bun run doctor");
  } else {
    console.log("  能跑起来了（有 " + warnings.length + " 条提醒，不影响）。开局域网，然后：bun run bot");
  }
  console.log("");
  process.exit(broken.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error("自检本身出错了：" + (e as Error).message);
  process.exit(1);
});
