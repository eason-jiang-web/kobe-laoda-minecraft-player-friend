# 文档索引

先看哪个：

| 文档 | 什么时候看 |
|---|---|
| **[../README.md](../README.md)** | 第一次拿到项目 —— 五分钟跑起来 |
| **[PCL_DEEPSEEK_SETUP.md](./PCL_DEEPSEEK_SETUP.md)** | **主教程**（中文逐步）：PCL 世界 + DeepSeek、硬指令、`#follow play`、op、换版本、排查 |
| **[SKIN_AND_MENU.md](./SKIN_AND_MENU.md)** | 给他换皮肤、桌面菜单和那些启动器都是干嘛的 |

---

## ⚠️ 下面这五个是**上游历史设计文档**

它们描述的是这个项目**还是 Hermes + Discord 那套**时的样子（人设叫 itto/jabby、脑子在仓库外面、
语音走 Discord）。现在的实现已经不同了：脑子内置成 DeepSeek、人设是牢大、只在游戏聊天栏说话（语音模块已删除）。

留着是因为里面有**原始的设计思路**（快慢双循环、MCP 分层、为什么反射不能排在大模型后面），
读架构时仍有价值 —— 但**具体配置和文件名别照它做**，以 README 和 PCL_DEEPSEEK_SETUP 为准。

| 文档 | 内容 |
|---|---|
| [CONTEXT.md](./CONTEXT.md) | 最初的项目规格与人设设定 |
| [ROADMAP.md](./ROADMAP.md) | 最初的开发顺序与分工 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构图（双循环 + MCP 分层，这部分现在依然成立） |
| [RUNBOOK.md](./RUNBOOK.md) | 最初"谁跑什么"的运维说明 |
| [HERMES_SETUP.md](./HERMES_SETUP.md) | 上游用 Hermes 当脑子的接法（本项目不用了） |
