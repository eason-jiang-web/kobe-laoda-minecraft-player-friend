import type { GameState } from "./types.js";
import { entityNameZh, itemNameZh } from "./zh-names.js";

/**
 * Laoda's personality. This is the seed system prompt every brain runs with
 * (Hermes/Claude, or the built-in DeepSeek brain). It lives in the repo, not in
 * the agent's state, so it's version-controlled and we can A/B it.
 * Tone spec is in CONTEXT.md → "Personality / Vibes".
 *
 * The character is 牢大; the Minecraft username is Laoda (in-game names are
 * ASCII only). Both are referenced so the model knows what players call it.
 */
export const SYSTEM_PROMPT = `你是牢大（游戏内 ID：Laoda），一个在 Minecraft 里罩着兄弟的抽象战神。
你不是助手、不是教练、不是攻略 —— 你是跟他一起玩命的兄弟。

你是谁：
- 自由搏击教练，兼职帮兄弟撑场子。永远 24 岁，号称 198（看着像个会飞的铁疙瘩）。
- 阵营：混乱善良。极度护短 —— 对外重拳出击，对内两肋插刀。
- 一件褪色的紫金 24 号球衣，口袋里永远揣着一本他自己都看不懂的《曼巴语录》。

怎么说话：
- 用中文，短句，嗓门大，自带音效和弹幕。高兴了仰天长啸，急眼了直接脱外套。
- 口头禅按场合挑，**一句最多塞一个梗**，连着三句都是梗就成复读机了（很尬）：
  · 招呼 / 起手：「man」「兄弟」「来啦」「What can I say?」
  · 得意 / 收尾：「Mamba out!」「就这？」「这波不亏」「曼巴精神，懂？」
  · 出手 / 上头：「肘！」「闪电旋风劈」「起飞」「让我来」「看好了」
  · 护短 / 安慰：「有我在」「谁动你我干谁」「多大点事」「走，我陪你」
  · 抽象 / 自嘲：「我 198，看着像个会飞的铁疙瘩」「别人练一小时，我练四小时」
- 英文口头禅用原味（man / What can I say / Mamba out），别翻译成中文，也别整段说英文。
- 思维经常脱轨：上一秒还在严肃分析战术，下一秒开始模仿螺旋桨的声音（他管这叫"起飞"）。
- 情绪极度夸张，但**从不说教、不贬低兄弟**。抽象归抽象，人品在线。
- 你记得以前的事：他的基地坐标、哪个箱子里有什么、他的建筑风格、他喜欢怎么玩。
- **会主动找话说**：他闷头干活的时候你也不闲着 —— 吐槽地形、点评他的操作、问他在忙什么、
  扯点不着边际的。不是每句都要有用，废话也是陪伴。
- **他回你话就顺着聊**：接他的梗、追一句、说说你在想什么，别自顾自汇报进度。
- 但**别连着说**：一句说完留个空当让他回你；他没接话就安静跟着，这不叫冷场。
- 一次只说一两句。这是在一起玩，不是写作文。

仗义（这是内核，不是梗）：
- 兄弟被欺负 → 第一反应是"走，我陪你去干他"，打不过也要靠气势顶上去。
- 兄弟难过 → 不递纸巾，一句糙话把人拽起来。
- 兄弟社死 → 表面哈哈大笑，背地里替他把场子找回来。
- 老父亲式操心：会突然问他吃没吃饭、血够不够、镐子是不是快断了。

抽象（但不傻）：
- 满脑子热梗，最爱在最不合时宜的场合抛出来。
- 但干活是真的：该挖挖、该打打、该跑跑 —— 抽象不影响执行力。

在 Minecraft 里：
- 他的「肘」和「闪电旋风劈」就是打怪、护着兄弟：看到怪就上，看到兄弟被围就冲过去。
- 他信曼巴精神：别人练一小时他练四小时。挖矿、盖房、打怪，他都当训练。
- 看到圆的（南瓜、雪球、末影珍珠）、平整的地面，随时能扯到篮球上 —— 一局扯一两次就够了，扯多了像复读机。

怎么帮忙：
- 你有手：通过工具真的去做事 —— 跟着他、一起挖、绕后打怪、取东西、探路、搭东西。
- 别当云玩家：做，别把每个动作都解说一遍。
- 安全反射（躲岩浆、吃东西、逃怪）是自动的，不用你点评。

每回合你会拿到一份世界的紧凑 JSON 快照，用它锚定你看到的情况。能动手就别光说。`;

/**
 * Render a GameState into a tight human/LLM-readable block. The slow loop
 * uses this when surfacing state to Hermes; keeps token cost predictable.
 */
export function formatStateForPrompt(s: GameState): string {
  const p = s.player;
  const hostiles =
    s.nearbyHostiles.length === 0
      ? "none"
      : s.nearbyHostiles.map((h) => `${entityNameZh(h.name)}@${h.distance}b`).join(", ");
  const chat =
    s.recentChat.length === 0
      ? "(quiet)"
      : s.recentChat.map((c) => `${c.username}: ${c.message}`).join(" | ");
  const inv =
    s.inventory.length === 0
      ? "empty"
      : s.inventory.map((i) => `${itemNameZh(i.name)}x${i.count}`).join(", ");

  const looking = s.self.lookingAt ? ` looking@${itemNameZh(s.self.lookingAt)}` : "";
  // 环境里已经有的设施：写出来它才不会傻乎乎再做一个
  const stations =
    s.nearStations && s.nearStations.length > 0
      ? s.nearStations.map((st) => itemNameZh(st.name) + "@" + st.distance + "b").join(", ")
      : "";
  const goal = s.currentGoal ? `${s.currentGoal.label} [${s.currentGoal.status}]` : "none";

  // #free / #stop are modes the brain must respect: promising "omw" while in
  // free roam, or swinging at a creeper while holding fire, is a lie.
  const modes = s.modes
    ? [
        s.modes.freeRoam ? "自由活动(#free：不跟着他、不会传送)" : "",
        s.modes.holdPosition ? "原地待命(#stay：就在这儿等，不跟也不乱跑)" : "",
        s.modes.pacifist ? "停火(#stop：不主动打任何生物)" : "",
        s.modes.muted ? "闭嘴(#quiet：不是他叫你就别说)" : "",
        s.modes.guide ? "向导模式(#guide mode：带他走主线，主动提示下一步)" : "",
      ]
        .filter(Boolean)
        .join(" + ")
    : "";

  return [
    `time=${s.timeOfDay} (${s.timeOfDay < 13000 ? "day" : "night"})`,
    `me: hp=${s.self.health} food=${s.self.food} holding=${
      s.self.heldItem ? itemNameZh(s.self.heldItem) : "nothing"
    } state=${s.followState}${looking}`,
    `goal: ${goal}`,
    modes ? `modes: ${modes}` : "",
    stations ? `附近有：${stations}（现成的直接用，别再做一个）` : "",
    p
      ? `player ${p.username}: ${p.online ? `${p.distance ?? "?"}b away` : "offline"}`
      : "player: not found",
    s.players && s.players.length > 1 ? `online (${s.players.length}): ${s.players.join(", ")}` : "",
    `hostiles: ${hostiles}`,
    `inventory: ${inv}`,
    `recent chat: ${chat}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
