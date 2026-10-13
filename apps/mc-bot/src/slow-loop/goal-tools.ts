import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "@itto/mcp-server";
import { SetGoalInput } from "@itto/shared";
import { sameIntent, type GoalRunner } from "./goal-runner.js";

/**
 * Goal tools — how the brain pursues multi-step work. Instead of doing
 * everything in one nudge, the brain sets a goal and the body pursues it,
 * pinging back on completion. Registered app-side (holds the runner).
 */
export function registerGoalTools(server: McpServer, runner: GoalRunner): void {
  server.tool(
    "set_goal",
    "Set what you should pursue right now (replaces the current goal). Use this for multi-step work like 'chop a tree' or 'fetch iron' — the body pursues it and pings you when it's done.",
    SetGoalInput.shape,
    async ({ intent, label }) => {
      // 已经在做同一件事 → 明确告诉它"别重复设"，别把跑着的目标推倒
      const cur = runner.currentGoal();
      if (cur && cur.status === "active" && sameIntent(cur.intent, intent)) {
        return ok(
          "这个已经在做了（" + cur.label + (cur.progress ? "：" + cur.progress : "") +
            "）—— 别重复设，等它跑完。你现在该说话就说话，该搭把手就搭把手。",
          { id: cur.id, label: cur.label, status: cur.status },
        );
      }
      const goal = runner.setGoal(intent, label);
      return ok(`on it: ${goal.label}`, { id: goal.id, label: goal.label, status: goal.status });
    },
  );

  server.tool(
    "get_goal",
    "Check what you are currently working on.",
    {},
    async () => {
      const goal = runner.currentGoal();
      if (!goal) return ok("no current goal", null);
      return ok(`${goal.label} [${goal.status}]${goal.progress ? `: ${goal.progress}` : ""}`, goal);
    },
  );

  server.tool(
    "cancel_goal",
    "Stop whatever you are currently doing and clear the goal.",
    {},
    async () => {
      runner.cancel();
      return ok("stopped");
    },
  );
}
