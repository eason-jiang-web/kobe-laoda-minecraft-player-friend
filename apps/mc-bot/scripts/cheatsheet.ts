#!/usr/bin/env bun
/**
 * 打印"指令表"—— 菜单里那个独立的说明窗口跑的就是它。
 *
 * 内容全部来自 COMMANDS 表和 startupBanner.ts 里的同一套渲染：
 * 加一条硬命令，这个窗口、机器人启动横幅、#help 三处一起更新，不会漂移。
 *
 *   bun run apps/mc-bot/scripts/cheatsheet.ts
 */
import { COMMANDS } from "../src/chat-commands.js";
import { cheatSheet } from "../src/util/startup-banner.js";

const username = process.env.MC_BOT_USERNAME?.trim() || "Laoda";
const owner = process.env.MC_OWNER_USERNAME?.trim() || "你";
// 端口直接从 .env 读 —— 说明窗口里写的数字永远等于机器人真正要连的端口，
// 不会出现"文档写 25565、.env 改成别的"这种对不上。
const host = process.env.MC_SERVER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.MC_SERVER_PORT ?? 25565) || 25565;
// 大脑开没开也一起打出来 —— 关着的时候机器人不说话，看着像坏了，
// 而说明书窗口正是玩家最容易看到的地方，得在这儿就说清楚。
const brain = {
  enabled: process.env.BRAIN_ENABLED === "true",
  cmd: process.env.BRAIN_CMD ?? "",
};

console.log(cheatSheet(username, owner, COMMANDS, { host, port }, brain).join("\n"));
// 这几句以前写在 指令说明.cmd 里 —— 但 cmd.exe 处理含中文的批处理会在字节边界错位
// （实测：「牢大」这种字会把下一行 echo 切成命令去执行）。所以 .cmd 只留 ASCII，
// 所有给人看的中文都从这里打出去。
console.log("");
console.log("  ============================================================");
console.log("    这个窗口可以一直开着 —— 关掉不影响游戏。");
console.log("    想再打开：桌面「牢大」按 3，或者双击本目录的 指令说明.cmd");
console.log("  ============================================================");
console.log("");
