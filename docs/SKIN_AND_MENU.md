# 皮肤 & 菜单（牢大的身体）

两件事：给他一张脸，和一个"按一下就能玩起来"的菜单。

---

## 一、皮肤

> **跑脚本前的一次性设置（已经帮你开好了）**
> Windows PowerShell 出厂默认禁止运行任何脚本。已经把你的用户级策略设成 `RemoteSigned`：
> 本地脚本直接就能跑（网上下载的脚本要先 `Unblock-File` 一下），
> 所以你不用再写 `-ExecutionPolicy Bypass` 那一长串。
> 自己确认 / 重设（不需要管理员）：`Get-ExecutionPolicy -List`、`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

先说清楚**为什么不能直接给他设皮肤**：

Minecraft 里玩家的皮肤是服务端向 Mojang 查的（正版档案里的 texture 属性）。
局域网世界是**离线验证**，机器人没有正版账号 → 服务端查不到 → 客户端画默认皮肤
（Steve / Alex 之一）。这不是 itto 的 bug，是离线玩家的通用限制。

三条可行路线，按省事排序：

### 方案 A：客户端本地皮肤（推荐，5 分钟，只有你自己看得到）

局域网世界只有你一个人在用眼睛看，所以**只改你自己的客户端就够了**。

1. 装好皮肤文件（仓库里已经带了一张我给他画的原创牢大，`assets/skins/laoda.png`）。
   **直接双击仓库根目录的 `安装皮肤.cmd`** 就行 —— 会弹一个终端窗口，跑完停在那里给你看结果。

   命令行等价写法：

   ```powershell
   cd "<你放这个项目的目录>"
   .\scripts\install-skin.ps1
   ```

   它会复制到 `%APPDATA%\.minecraft\CustomSkinLoader\LocalSkin\skins\Laoda.png`。
   （PCL 开了版本隔离就加参数：`-MinecraftDir "D:\PCL\.minecraft"`）

2. 给你的 1.20.6 装 **Fabric**（PCL：版本设置 → 安装 Fabric）。
3. 下载 **CustomSkinLoader** 的 jar 丢进 `.minecraft\mods\`：
   <https://www.curseforge.com/minecraft/mc-mods/customskinloader>
4. 用这个版本进游戏。名字是 `Laoda` 的玩家就显示这张皮肤了。

> 装了 Fabric 之后你的世界就变成 Fabric 服务端了。Fabric **不强制**客户端装模组，
> 所以 Mineflayer 还是能进（CustomSkinLoader 本身是纯客户端模组）。
> 但以后再加别的模组就要留神。

**想换皮肤**：任何 64×64 的皮肤 PNG 都行 —— 从 <https://www.minecraftskins.com>
之类的地方挑一张喜欢的，然后：

```powershell
.\scripts\install-skin.ps1 -Skin "D:\下载\我喜欢的.png"
```

仓库里那张是我用代码画的（`scripts/make-laoda-skin.ts`，改颜色重跑就行）：
褐色皮肤、黑色短发、湖人紫金 24 号球衣、白色球鞋。预览：`assets/skins/laoda-preview.png`。

### 方案 B：给机器人一个正版账号（所有人都能看到）

买/借一个小号，在 minecraft.net 上传皮肤，然后 `.env`：

```
MC_AUTH=microsoft
MC_BOT_EMAIL=那个账号的邮箱
```

第一次启动会在终端打印 microsoft.com/link 链接和设备码，浏览器登录一次即可
（登录的是**机器人的账号**，不是你的）。之后皮肤由服务端下发，谁都能看到，不用装模组。

### 方案 C：开 Paper 服务器 + SkinsRestorer（所有人可见，不用正版）

把世界搬到本地 Paper 服务端，装 SkinsRestorer 插件，你和机器人都连
`127.0.0.1:25565`。最干净的做法，但要先把存档搬过去。
（仓库自带 `infra/docker-compose.yml` 的 Paper 配置，需要 Docker。）

---

## 附：双击「牢大」就行

桌面上只有一个快捷方式 **「牢大」**（图标是他的脸，来自 `assets/skins/laoda-head.ico`），
点开是一个菜单：

   ```
     [1] 一键开玩    机器人 + 指令表（默认，等 8 秒自动选这个）
     [2] 只开机器人  不想开指令表的时候用
     [3] 指令表      所有 #指令、/op、端口，单独一个窗口
     [4] 安装皮肤    一次性，装完就不用再点
     [5] 给权限      让他能瞬移（要先退到标题画面）
     [0] 退出
   ```

它背后是 `牢大.cmd` → `scripts/menu.ps1`，再调用仓库根目录这几个启动器
（想跳过菜单直接双击某个也行）：

| 文件 | 干什么 |
|---|---|
| `启动牢大.cmd` | 启动机器人 + 大脑（= `bun run bot`），关掉窗口就停 |
| `一键开玩.cmd` | = 菜单的选项 1（机器人 + 指令表，一次开两个窗口） |
| `指令说明.cmd` | 指令表窗口（`/op`、端口、每条 #指令 的完整用法）；按 1 时会自动一起开 |
| `安装皮肤.cmd` | 把牢大皮肤装进 CustomSkinLoader |
| `牢大.cmd` | 菜单（桌面快捷方式指向它） |
| `给牢大开权限.cmd` | 关掉世界后双击：找出存档、把牢大写进 `ops.json`（省得在游戏里打 `/op Laoda`） |

**为什么是 .cmd 而不是直接双击 .ps1？** Windows 不允许程序偷偷改 `.ps1` 的默认打开方式：
它给文件关联加了一个防篡改哈希（你的机器上是 `UserChoice = VSCode.ps1`）。
我实测过 —— 把那个键删掉、写好关联，几秒后 Windows 又把它还原回去了。这是设计如此，绕不过去。

所以：

- **双击运行** → 用桌面的「牢大」或上面这些 `.cmd`（效果一样：开终端 + 跑起来，窗口会停住让你看输出）
- **右键 .ps1** → 现在多了一个 **「在终端运行」** 菜单项，直接跑任意 .ps1
- **双击 .ps1** → 仍然是 VS Code 打开（方便你改代码，这是好事）

> ⚠️ 改这两个 `.ps1` 的时候注意：文件必须是 **UTF-8 带 BOM**。
> PowerShell 5.1 没有 BOM 就按 GBK 读，中文全部乱码、脚本直接解析失败。
> （记事本、VS Code 默认会保留 BOM；某些工具会悄悄去掉。）
>
> ⚠️ 反过来，**`.cmd` 里一个字的中文都不能写**（只能用 ASCII）。
> cmd.exe 是按字节读批处理的，遇到 UTF-8 多字节字符会在续读时错位 ——
> 实测一个带「」和：的 echo 行被切成两半，后半截被当成命令去执行：
> `'ot' is not recognized as an internal or external command`。
> 加 BOM 也治不好（带 BOM 和不带 BOM 都错）。所以这些 .cmd 只负责"调用"，
> 中文提示全部由 bun / PowerShell 脚本打出来（`scripts/launchers.test.ts` 会守住这条规矩）。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `assets/skins/laoda.png` | 牢大的皮肤（64×64，原创） |
| `scripts/make-laoda-skin.ts` | 生成那张皮肤的代码（改颜色/细节重跑即可） |
| `scripts/install-skin.ps1` | 把皮肤装进 CustomSkinLoader |
| `scripts/menu.ps1` | 桌面快捷方式背后的菜单 |
| `apps/mc-bot/src/util/startup-banner.ts` | 指令表 / 启动横幅的文案（从命令表自动生成） |
| `apps/mc-bot/scripts/cheatsheet.ts` | 「指令说明.cmd」跑的那个脚本 |

> **语音模块已经删掉了**（2026-10）：终端那套"Windows 麦克风识别 + TTS"、
> 游戏内的 Simple Voice Chat、vendored 的语音插件、上游那个从没用过的 Discord 语音包
> 全都不在了 —— 牢大现在只在游戏聊天里说话。
> 想让它听见你：聊天栏打字，或者用系统语音输入（Win+H）把话打进聊天框。
