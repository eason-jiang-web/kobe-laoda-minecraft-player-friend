# @itto/brain-deepseek

牢大's brain (game ID `Laoda`), running on the DeepSeek API instead of an
external Hermes agent.
This is the thing that decides whether to say something in game and which tool
to call — the Mineflayer bot itself (`apps/mc-bot`) is just the body.

It plugs into the existing "any agent that can reach the MCP server" seam:
the slow loop spawns it with a prompt as the last argument, and it talks back
to the bot over MCP (`http://localhost:3001/mcp`).

```
slow loop nudge ──spawn──► bun apps/brain-deepseek/src/index.ts "<prompt>"
                                    │
                                    ├─ MCP: list tools + resources  ──► itto-mc :3001
                                    ├─ DeepSeek /chat/completions    ──► api.deepseek.com
                                    └─ MCP: callTool("chat", ...)    ──► itto-mc :3001
```

## Config (repo-root `.env`)

| Var | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | required, from platform.deepseek.com |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | 默认（聪明）模型。API 只认 `deepseek-flash` / `deepseek-v4-pro`；两个都支持工具调用 |
| `BRAIN_FAST_MODEL` | `deepseek-flash` | （身体侧配置）优先级唤醒——有人跟它说话/有危险时——用快模型，自己琢磨时用上面的聪明模型 |
| `ITTO_BRAIN_MODEL` | — | 单次唤醒的模型覆盖，由身体按优先级传进来（不用手填） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | any OpenAI-compatible endpoint works |
| `ITTO_MCP_URL` | `http://localhost:3001/mcp` | where the bot serves MCP |
| `BRAIN_MAX_STEPS` | `6` | model round-trips per wake |
| `BRAIN_BUDGET_MS` | `120000` | hard wall-clock cap per wake |
| `BRAIN_TOOL_TIMEOUT_MS` | `120000` | per MCP tool call (skills like `chop_tree` are slow) |
| `BRAIN_HISTORY_PATH` | `data/brain-history.json` | rolling "what did I just say/do" memory |
| `BRAIN_DEBUG` | — | `1` for a verbose trace on stderr |

Turn it on for the bot with:

```bash
BRAIN_ENABLED=true
BRAIN_CMD=bun apps/brain-deepseek/src/index.ts
BRAIN_DIR=/absolute/path/to/itto
```

## Running it by hand

```bash
# what does the bot expose right now? (no model call, no tokens)
bun run --cwd apps/brain-deepseek start --check

# one full turn, with the bot running
bun apps/brain-deepseek/src/index.ts 'eason just said: 牢大 come here'
echo 'heartbeat: anything worth doing?' | bun apps/brain-deepseek/src/index.ts -

# fake model + fake itto-mc, asserts the whole loop works (free, no key needed)
bun run --cwd apps/brain-deepseek smoke

bun test apps/brain-deepseek
```

## How a wake works

1. Connect to itto-mc, `listTools()` + `listResources()`.
2. Every MCP tool becomes a DeepSeek function tool (schemas normalised in
   `src/schema.ts`: `$ref` inlined, nullable unions flattened — model APIs are
   pickier than MCP).
3. MCP *resources* aren't tools, so they're exposed as one synthetic
   `read_resource` tool. That's how 牢大 reads live world state
   (`itto://state/current.txt`) and its own memory (`itto://memory/world`).
4. Loop: model -> tool calls -> MCP results -> model, until it stops calling
   tools or `BRAIN_MAX_STEPS`/`BRAIN_BUDGET_MS` runs out.
5. Append what it said/did to `data/brain-history.json` (each wake is a fresh
   process, so this file is the only continuity) and exit.

Exit code 0 = handled (including "stayed quiet"). Non-zero = the bot logs a
warning and moves on; it never blocks the fast loop.

## Cost

One wake is usually 1-2 `deepseek-chat` calls with a ~1-2 KB state snapshot and
the tool list. `BRAIN_COOLDOWN_MS` (default 10s) plus the slow loop's own
triggers keep the call rate low; raise the cooldown or set `HEARTBEAT_MS=0`
if you want it quieter and cheaper.
