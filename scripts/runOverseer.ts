import fs from "fs";
import path from "path";
import { sendMessage } from "./telegram";

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const PUBLIC_DIR = path.join(ROOT_DIR, "public-data");

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T>(filePath: string, fallback?: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function getAgentStates(): any[] {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readJson<any>(path.join(AGENTS_DIR, fileName)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getLatestRuns(limit: number): any[] {
  if (!fs.existsSync(LOGS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(LOGS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map((fileName) => readJson<any>(path.join(LOGS_DIR, fileName)));
}

function buildLeaderboard(agentStates: any[]) {
  return {
    generatedAt: new Date().toISOString(),
    agents: agentStates
      .map((agent) => {
        const revenue = Number(agent.revenue || 0);
        const cost = Number(agent.cost || 0);
        const profit = Number((revenue - cost).toFixed(2));

        return {
          name: agent.name,
          strategy: agent.strategy,
          revenue,
          cost,
          profit,
          status: agent.status,
          lastAction: agent.lastAction || "",
          lastRunAt: agent.lastRunAt || ""
        };
      })
      .sort((a, b) => b.profit - a.profit)
  };
}

function buildTelegramSummary(leaderboard: any, blockedTasks: any[]): string {
  const lines: string[] = [];
  lines.push("AI Money Arena Summary");
  lines.push("");

  for (const agent of leaderboard.agents) {
    lines.push(
      `${agent.name}: ${agent.lastAction || "No action"} | revenue=${agent.revenue} | cost=${agent.cost} | profit=${agent.profit} | status=${agent.status}`
    );
  }

  lines.push("");
  lines.push(`Blocked tasks: ${blockedTasks.length}`);

  for (const task of blockedTasks.slice(0, 10)) {
    lines.push(`- ${task.agent}: ${task.task}`);
  }

  return lines.join("\n").slice(0, 3900);
}

async function run(): Promise<void> {
  ensureDir(PUBLIC_DIR);

  const config = readJson<any>(path.join(STATE_DIR, "config.json"), {});
  const agentStates = getAgentStates();
  const tasks = readJson<any[]>(path.join(STATE_DIR, "tasks.json"), []);
  const blockedTasks = tasks.filter((task) => task.status !== "done");
  const leaderboard = buildLeaderboard(agentStates);
  const latestRuns = getLatestRuns(config.latestRunsLimit || 15);

  writeJson(path.join(STATE_DIR, "leaderboard.json"), leaderboard);
  writeJson(path.join(PUBLIC_DIR, "leaderboard.json"), leaderboard);
  writeJson(path.join(PUBLIC_DIR, "latest-runs.json"), {
    generatedAt: new Date().toISOString(),
    runs: latestRuns
  });
  writeJson(path.join(PUBLIC_DIR, "tasks.json"), {
    generatedAt: new Date().toISOString(),
    tasks: blockedTasks
  });

  console.log("[overseer] Public data updated");
  console.log(`[overseer] Agents: ${agentStates.length}, blocked tasks: ${blockedTasks.length}`);

  try {
    const summary = buildTelegramSummary(leaderboard, blockedTasks);
    const result = await sendMessage(process.env.TELEGRAM_CHAT_ID || "", summary);
    if (result?.skipped) {
      console.log("[overseer] Telegram summary skipped");
    } else {
      console.log("[overseer] Telegram summary sent");
    }
  } catch (error: any) {
    console.log(`[overseer] Telegram send skipped/failed: ${error.message}`);
  }
}

run().catch((error) => {
  console.error("[overseer] Fatal error:", error);
  process.exit(1);
});
