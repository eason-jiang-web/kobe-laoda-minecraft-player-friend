import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertPortAvailable, createMcpServer, serveHttp } from "@itto/mcp-server";
import { loadConfig } from "./config.js";
import type { Bot } from "mineflayer";
import { createBot, onBotDead, type CreateBotOptions } from "./bot/create-bot.js";
import { BotController } from "./bot/controller.js";
import { FastLoop } from "./fast-loop/index.js";
import { SlowLoop, consoleNudgeSink } from "./slow-loop/index.js";
import { createAgentBrainSink } from "./slow-loop/agent-sink.js";
import { GoalRunner } from "./slow-loop/goal-runner.js";
import { registerGoalTools } from "./slow-loop/goal-tools.js";
import { registerSkillTools, runSkillByName } from "./skills/index.js";
import type { SkillContext } from "./skills/types.js";
import { WorldMemory } from "./memory/store.js";
import { registerMemoryTools } from "./memory/tools.js";
import { pushChat } from "./state/extract.js";
import { pushSystem } from "./state/system-log.js";
import { watchPlayerActions } from "./state/action-watch.js";
import { clearPlayerActions } from "./state/player-actions.js";
import { COMMANDS, matchCommand } from "./chat-commands.js";
import { startupBanner } from "./util/startup-banner.js";
import { opHint } from "./util/op-hint.js";
import { loadChineseNames } from "./util/zh-lang.js";
import { portLine } from "./util/startup-banner.js";
import { connectWithRetry, shouldExplain } from "./util/connect-retry.js";
import { assertSupportedVersion } from "./bot/versions.js";
import { currentCaps } from "./value-caps.js";
import { setLogLevel, logger } from "./util/logger.js";
import { areaForGoal, HABIT, isOwnerEcho } from "@itto/shared";

const log = logger("main");

/**
 * Boot sequence — this is where the whole machine comes together:
 *
 *   1. spawn the Mineflayer bot
 *   2. wrap it in a BotController (the single control surface)
 *   3. start the fast loop (15Hz follow + safety, pure code)
 *   4. start the slow loop (~4s trigger detection → nudges to Hermes)
 *   5. stand up the MCP server over HTTP so Hermes can connect + drive it
 *
 * Hermes itself runs SEPARATELY and connects to the MCP endpoint. It owns the
 * model + Discord voice. We just expose the body and the senses.
 */
async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info("booting itto…");

  // Check the MCP port BEFORE joining the world: the usual reason it's taken is
  // that an earlier itto is still running, and a bot that logs in only to die
  // two seconds later is worse than one that never logged in.
  await assertPortAvailable(cfg.mcp.host, cfg.mcp.port);

  // 版本写错是"重试也没用"的错误 —— 让它立刻死，别陷在重试循环里。
  assertSupportedVersion(cfg.mc.version);

  // 让他眼里的世界说中文：物品/方块/生物的中文名从**你本机 Minecraft 的语言文件**读
  // （assets 里那份 zh_cn.json，8500+ 条），和你在屏幕上看到的逐字一致。
  // 读不到不是错误 —— 退回内置小词典，最差显示英文 id。
  const appData = process.env.APPDATA;
  const zh = loadChineseNames(
    [cfg.mc.gameDir, appData ? join(appData, ".minecraft") : undefined].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
  );
  if (zh) log.info("中文名已加载：" + zh.count + " 条（" + zh.source + "）");
  else log.warn("没找到 Minecraft 的中文语言文件 —— 物品名会用内置词典/英文 id 显示");

  const botOpts: CreateBotOptions = {};

  // 1 + 2
  // 连不上很正常：顺序反了（先开窗口再进世界）、或者「对局域网开放」的端口
  // 忘了从随机值改成 25565。旧行为是一失败就退出，窗口留着但机器人没了；
  // 现在跟断线重连一样一直等，并且每次失败都把端口这件事说一遍。
  const bot = await connectWithRetry({
    connect: () => createBot(cfg, botOpts),
    retry: cfg.reconnect.enabled,
    delayMs: cfg.reconnect.delayMs,
    maxDelayMs: cfg.reconnect.maxDelayMs,
    onFail: (err, attempt) => {
      log.warn("连不上 " + cfg.mc.host + ":" + cfg.mc.port + "（第 " + attempt + " 次）—— " + err.message);
      log.warn(portLine(cfg.mc.host, cfg.mc.port));
      if (shouldExplain(attempt)) {
        log.warn(
          "再对一遍：① 世界开好了吗 ② 「对局域网开放」的端口是不是 " + cfg.mc.port +
            " ③ 版本是不是 " + cfg.mc.version + "（.env 的 MC_VERSION 必须一模一样）",
        );
      }
      log.info("我在这儿等着 —— 弄好它自己就进来了（Ctrl+C 或关窗口才会停）。");
    },
  });
  const controller = new BotController(bot, cfg);

  // world memory: MC-specific spatial facts (waypoints, chest index). Survives
  // reconnects + restarts. Persisted to data/world.db at the repo root.
  mkdirSync("data", { recursive: true });
  // 画像摘要单独写一个文件：大脑是另一个进程（每次唤醒新开），只能读文件 ——
  // 和自修笔记（data/wiki/notes.json）一个套路。
  const memory = new WorldMemory("data/world.db", { digestPath: "data/profile-digest.txt" });

  // 3 — fast loop owns the follow controller; the state extractor reads its state
  const fast = new FastLoop(bot, cfg);
  fast.start();

  // skills context + the goal runner (executes the brain's multi-step intents)
  const skillCtx: SkillContext = {
    control: controller,
    memory,
    suspendFollow: () => fast.follow.suspend(),
    resumeFollow: () => fast.follow.resume(),
  };
  const runner = new GoalRunner({
    control: controller,
    runSkill: (name, args) => runSkillByName(skillCtx, name, args),
    suspendFollow: () => fast.follow.suspend(),
    resumeFollow: () => fast.follow.resume(),
    onComplete: (goal) => {
      // 边玩边长本事：这个任务算哪门子功夫，成了还是砸了。
      // 认不出来的（say / follow / 自由活动）就不记 —— 熟练度只统计真干过的活。
      const intent = goal.intent;
      const area = areaForGoal(
        intent.kind,
        intent.kind === "skill" ? intent.name : undefined,
        intent.kind === "collect" ? intent.item : undefined,
      );
      if (area) memory.noteOutcome(area, goal.status === "done");
      slow.notifyGoalComplete(goal);
    },
  });

  // stamp live followState + currentGoal onto every snapshot
  const origGetState = controller.getState.bind(controller);
  controller.getState = () => {
    const g = runner.currentGoal();
    const lg = runner.lastGoalFinished();
    return {
      ...origGetState(),
      followState: fast.followState(),
      currentGoal: g ? { id: g.id, label: g.label, status: g.status, progress: g.progress } : null,
      lastGoal: lg ? { id: lg.id, label: lg.label, status: lg.status, progress: lg.progress } : null,
      // #free / #stop live on the controller, so stamp them on here — the brain
      // needs to know it's in free roam before it promises to come running.
      modes: {
        freeRoam: controller.isFreeRoam(),
        pacifist: controller.isPacifist(),
        holdPosition: controller.isHoldPosition(),
        muted: controller.isMuted(),
        guide: controller.isGuide(),
      },
      // 玩家用 #value 改过的上限 —— 评估层、向导、大脑都读这一份
      valueCaps: currentCaps(),
    };
  };

  // 4 — slow loop. The sink routes "nudges" (something worth reacting to) to
  // the brain: an external agent when configured, else just log.
  const sink =
    cfg.brain.enabled && cfg.brain.cmd.length > 0
      ? createAgentBrainSink({
          cmd: cfg.brain.cmd,
          dir: cfg.brain.dir,
          cooldownMs: cfg.brain.cooldownMs,
          chatCooldownMs: cfg.brain.chatCooldownMs,
          // 「这件事别再问了」的第二道保险：开口之前就让它知道额度用完了
          extraPrompt: () => memory.askHintLine(),
        })
      : consoleNudgeSink;
  if (cfg.brain.enabled) log.info("brain: external agent");
  const slow = new SlowLoop(controller, cfg, sink, runner, memory);
  slow.start();

  // 5 — MCP server: a fresh instance per connecting session (brain, dev
  // driver), all wired to the same controller/memory/runner. An McpServer
  // binds exactly one transport, so serveHttp calls this factory per session.
  const buildMcp = () => {
    const mcp = createMcpServer(controller);
    registerSkillTools(mcp, skillCtx);
    registerMemoryTools(mcp, memory, controller);
    registerGoalTools(mcp, runner);
    return mcp;
  };

  const http = await serveHttp(buildMcp, { host: cfg.mcp.host, port: cfg.mcp.port });
  log.info("itto is live. point the brain at the MCP endpoint and join the call.");

  // The runtime cheat-sheet: every hard command (generated from the command
  // table, so it can't drift) plus the one setup step that lives inside
  // Minecraft. Plain console.log so it shows even at LOG_LEVEL=warn.
  // eslint-disable-next-line no-console
  console.log(
    startupBanner(
      cfg.mc.username,
      cfg.mc.ownerUsername,
      COMMANDS,
      { host: cfg.mc.host, port: cfg.mc.port },
      // 大脑开没开必须打在终端最显眼的地方：关着的时候他不说话，看着像坏了
      { enabled: cfg.brain.enabled, cmd: cfg.brain.cmd.join(" ") },
    ).join("\n"),
  );

  // ── connection lifecycle + auto-reconnect ──
  // The MCP server, world memory, and loops persist across reconnects; only the
  // mineflayer Bot is recreated and rebound, so the brain's session survives.
  let activeBot = bot;
  let reconnecting = false;
  /** 玩家上一句原话（用来识别"他在催"而不是"他在提新要求"）。 */
  let lastOwnerChat: { text: string; at: number } | null = null;

  const onChat = (username: string, message: string) => {
    if (username === activeBot.username) return;

    // Hard commands first ("#back"): the body does them instantly, and they
    // never enter the chat buffer — so the brain can't answer the same line a
    // second time on its next wake.
    if (username.toLowerCase() === cfg.mc.ownerUsername.toLowerCase()) {
      // 他的习惯是**白捡**的：不用模型、不用额外回合，来一句话就记一笔。
      // 攒够了写进 data/profile-digest.txt，大脑下次醒来就知道他怎么玩。
      // 追问额度按"他最后说的这件事"算（模型换个 topic 名字也绕不过去）
      memory.setKv("last_request", message);
      memory.bumpHabit(HABIT.chat);
      memory.bumpHabit(HABIT.chatChars, message.length);
      memory.bumpHabit(HABIT.hour(new Date().getHours()));
      const lower = message.toLowerCase();
      if (cfg.mc.wakeWords.some((w) => lower.includes(w.toLowerCase()))) memory.bumpHabit(HABIT.wake);

      // 硬指令（#back 这种）**永远照做**，连按两次也照做两次 —— 它是"立刻执行"，
      // 不是"跟大脑说话"，所以不走下面那道去重。
      const hit = matchCommand(message);
      if (hit) {
        memory.bumpHabit(HABIT.command(hit.command.trigger));
        log.info(`command ${hit.command.trigger}${hit.arg ? " " + hit.arg : ""} from ${username}`);
        void hit.command
          .run(
            {
              control: controller,
              follow: fast.follow,
              runner,
              profile: () => memory.briefText(),
              // #follow play：看他正在干嘛，排一个同类的技能目标
              setSkill: (name: string, args?: Record<string, unknown>) =>
                runner.setGoal({ kind: "skill", name, args }, "跟着干：" + name).label,
            },
            hit.arg,
          )
          .then((reply) => (reply ? controller.chat(reply) : undefined))
          .catch((e) => log.warn(`command ${hit.command.trigger} failed: ${(e as Error).message}`));
        return;
      }

      // 同一句话他连说几遍 = **在催**，不是让你再答一遍。
      // 实测：两分钟里同一句「跟我垂直挖矿」触发了 45 次唤醒、45 句回复。
      // 他还在催就把窗口往后推 —— 一直催就一直不重复回应（第一遍已经开工了）。
      const now = Date.now();
      if (isOwnerEcho(lastOwnerChat, message, now)) {
        lastOwnerChat = { text: message, at: now };
        log.debug("他说了同一句话（在催），不重复回应：" + message.slice(0, 40));
        return;
      }
      lastOwnerChat = { text: message, at: now };
    }

    pushChat(username, message);
    slow.poke();
  };

  const handleDead = async (reason: string) => {
    if (reconnecting) return;
    reconnecting = true;
    log.warn(`connection lost (${reason})`);
    fast.stop();
    slow.stop();
    runner.cancel();
    if (!cfg.reconnect.enabled) {
      log.warn("reconnect disabled — exiting");
      memory.close();
      await http.close();
      process.exit(1);
    }
    let delay = cfg.reconnect.delayMs;
    for (;;) {
      log.info(`reconnecting in ${Math.round(delay / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delay));
      try {
        const nb = await createBot(cfg, botOpts);
        controller.rebind(nb);
        fast.rebind(nb);
        wireConnection(nb);
        fast.start();
        slow.start();
        reconnecting = false;
        log.info("reconnected.");
        return;
      } catch (e) {
        log.warn(`reconnect failed: ${(e as Error).message}`);
        delay = Math.min(delay * 2, cfg.reconnect.maxDelayMs);
      }
    }
  };

  function wireConnection(b: typeof bot): void {
    activeBot = b;
    b.on("chat", onChat);
    // The server's own voice: command feedback + errors. Kept so
    // run_server_command can report what actually happened.
    b.on("message", (msg) => pushSystem(msg.toString()));
    // 「他刚做了什么」：被打、捡到稀罕东西、完成进度、死亡、睡下、上下线。
    // 换连接就清空一次，免得上个会话的事件穿越过来（比如"他死了"其实是十分钟前那次）。
    clearPlayerActions();
    watchPlayerActions(b, { owner: cfg.mc.ownerUsername });
    onBotDead(b, (reason) => void handleDead(reason));
  }

  wireConnection(bot);

  // ── op 自检（整个进程只做一次）──
  // Minecraft 里玩家**不能给自己 op**，所以这条 /op 注定被拒。发它的意义在被拒
  // 之后：机器人在游戏里说一句人话，把两条真正能走的路告诉你。玩家在游戏里，
  // 终端不一定在看 —— 这句话必须留在游戏里。
  if (cfg.mc.selfOp) {
    void (async () => {
      // 等真正进世界（没 entity 时聊天发不出去）
      for (let i = 0; i < 60 && !activeBot.entity; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!activeBot.entity) return;
      try {
        const probe = await controller.probePermissions();
        if (probe.canTeleport) {
          // 常见情况：局域网开了作弊，权限本来就有 —— 什么都不说，别误报。
          log.info("权限自检：可以瞬移/用指令了（" + (probe.reply || "服务端没吭声") + "）");
          return;
        }
        log.warn(
          "权限自检：不够（" + (probe.reply || "服务端没吭声") + "）；/op 回执：" + (probe.opReply || "无"),
        );
        await controller.chat(opHint(cfg.mc.username, cfg.mc.ownerUsername));
      } catch (e) {
        log.debug("权限自检跳过：" + (e as Error).message);
      }
    })();
  }

  // graceful shutdown
  const shutdown = async () => {
    log.info("shutting down…");
    reconnecting = true; // don't try to reconnect while quitting
    fast.stop();
    slow.stop();
    await http.close();
    memory.close();
    activeBot.quit();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  // Log the message, not the Error object: Bun renders an Error with a source
  // frame, which buries a one-line config problem (like a taken port) in noise.
  // The stack is still there with LOG_LEVEL=debug.
  const err = e instanceof Error ? e : new Error(String(e));
  log.error(`fatal: ${err.message}`);
  log.debug(err.stack ?? "");
  process.exit(1);
});
