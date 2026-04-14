import fs from "fs";
import path from "path";
import { callGemini } from "./gemini";

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

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

function appendJsonArray<T>(filePath: string, entry: T): void {
  const items = readJson<T[]>(filePath, []);
  items.push(entry);
  writeJson(filePath, items);
}

function hasOpenTask(tasks: any[], agentName: string, taskTitle: string): boolean {
  return tasks.some((task) => task.agent === agentName && task.task === taskTitle && task.status !== "done");
}

function sanitizeDecision(decision: any) {
  return {
    action: String(decision?.action || "none").slice(0, 280),
    status: decision?.status === "blocked_waiting_for_human" ? "blocked_waiting_for_human" : "completed",
    reason: String(decision?.reason || "").slice(0, 500),
    task: typeof decision?.task === "string" ? decision.task.slice(0, 280) : ""
  };
}

function getAgentFile(agentName: string): string {
  return path.join(AGENTS_DIR, `${agentName}.json`);
}

function buildPrompt(agentState: any, messages: any[], tasks: any[], config: any): string {
  const recentMessages =
    messages.slice(-3).map((entry) => `- ${entry.agent}: ${entry.message}`).join("\n") || "- none";
  const openTasks =
    tasks
      .filter((task) => task.status !== "done")
      .slice(-3)
      .map((task) => `- ${task.agent}: ${task.task}`)
      .join("\n") || "- none";

  return [
    "Return JSON only.",
    "Pick one next money-making action for this agent.",
    `Agent: ${agentState.name}`,
    `Strategy: ${agentState.strategy}`,
    `Revenue: ${agentState.revenue}`,
    `Cost: ${agentState.cost}`,
    `Recent messages:\n${recentMessages}`,
    `Open tasks:\n${openTasks}`,
    `Output schema: {"action":"...","status":"completed|blocked_waiting_for_human","reason":"...","task":"optional"}`,
    `Keep it short and practical. Max ${config.maxActionChars || 140} chars for action.`
  ].join("\n");
}

async function run(): Promise<void> {
  const agentName = process.argv[2];

  if (!agentName) {
    throw new Error("Usage: node scripts/runWorker.js <agent-name>");
  }

  ensureDir(LOGS_DIR);

  const config = readJson<any>(path.join(STATE_DIR, "config.json"), {});
  const agentFile = getAgentFile(agentName);
  const agentState = readJson<any>(agentFile);
  const messagesPath = path.join(STATE_DIR, "messages.json");
  const tasksPath = path.join(STATE_DIR, "tasks.json");
  const messages = readJson<any[]>(messagesPath, []);
  const tasks = readJson<any[]>(tasksPath, []);

  console.log(`[worker] Running ${agentName}`);

  let decision: any;
  let runError: any = null;
  let nextTasks = tasks;

  try {
    const prompt = buildPrompt(agentState, messages, tasks, config);
    const geminiDecision = await callGemini(prompt, {
      timeoutMs: config.geminiTimeoutMs || 20000
    });
    decision = sanitizeDecision(geminiDecision);
  } catch (error: any) {
    runError = error;
    decision = {
      action: "none",
      status: "blocked_waiting_for_human",
      reason: "Gemini API failure",
      task: "Check Gemini API key, quota, or workflow logs"
    };
  }

  const now = new Date().toISOString();
  const profit = Number((agentState.revenue - agentState.cost).toFixed(2));

  agentState.lastAction = decision.action;
  agentState.lastReason = decision.reason;
  agentState.lastRunAt = now;
  agentState.status = decision.status;
  agentState.profit = profit;

  writeJson(agentFile, agentState);

  appendJsonArray(messagesPath, {
    timestamp: now,
    agent: agentState.name,
    type: decision.status,
    message: `${decision.action} (${decision.reason})`.slice(0, 500)
  });

  if (decision.status === "blocked_waiting_for_human" && decision.task && !hasOpenTask(tasks, agentState.name, decision.task)) {
    const taskEntry = {
      id: `${agentState.name}-${Date.now()}`,
      createdAt: now,
      agent: agentState.name,
      task: decision.task,
      reason: decision.reason,
      status: "open"
    };
    nextTasks = [...tasks, taskEntry];
    writeJson(tasksPath, nextTasks);
  }

  const logEntry = {
    timestamp: now,
    agent: agentState.name,
    action: decision.action,
    status: decision.status,
    reason: decision.reason,
    profit,
    errorMessage: runError ? String(runError.message || runError).slice(0, 500) : ""
  };

  fs.writeFileSync(path.join(LOGS_DIR, `${agentState.name}-${Date.now()}.json`), `${JSON.stringify(logEntry, null, 2)}\n`, "utf8");

  console.log(`[worker] ${agentName} -> ${decision.status}: ${decision.action}`);

  if (runError) {
    console.log(`[worker] ${agentName} error handled: ${runError.message}`);
  }
}

run().catch((error) => {
  console.error("[worker] Fatal error:", error);
  process.exit(1);
});
