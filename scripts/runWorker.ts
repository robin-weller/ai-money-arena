import fs from "fs";
import path from "path";
import { callGemini } from "./gemini";

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const FALLBACK_DECISION = {
  action: "none",
  status: "blocked_waiting_for_human",
  reason: "Invalid model output",
  task: null
};

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

function hasOpenTask(tasks: any[], agentName: string, taskTitle: string): boolean {
  return tasks.some((task) => task.agent === agentName && (task.title || task.task) === taskTitle && task.status !== "done");
}

function trimString(value: unknown, maxLength: number): string {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").slice(0, maxLength);
}

function extractJson(text: string): object | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const startIndex = candidate.indexOf("{");
  const endIndex = candidate.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  const jsonSlice = candidate.slice(startIndex, endIndex + 1);

  try {
    return JSON.parse(jsonSlice);
  } catch (_error: any) {
    return null;
  }
}

function isValidTask(task: any): boolean {
  return Boolean(
    task &&
      typeof task === "object" &&
      typeof task.title === "string" &&
      typeof task.details === "string" &&
      ["low", "medium", "high"].includes(task.priority)
  );
}

function isValidDecisionShape(decision: any): boolean {
  return Boolean(
    decision &&
      typeof decision === "object" &&
      typeof decision.action === "string" &&
      typeof decision.reason === "string" &&
      ["completed", "blocked_waiting_for_human"].includes(decision.status) &&
      (decision.task === null || isValidTask(decision.task))
  );
}

function sanitizeDecision(decision: any) {
  const task = isValidTask(decision?.task)
    ? {
        title: trimString(decision.task.title, 140),
        details: trimString(decision.task.details, 500),
        priority: decision.task.priority
      }
    : null;

  return {
    action: trimString(decision?.action || "none", 280),
    status: decision?.status === "blocked_waiting_for_human" ? "blocked_waiting_for_human" : "completed",
    reason: trimString(decision?.reason || "", 500),
    task
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
      .map((task) => `- ${task.agent}: ${task.title || task.task}`)
      .join("\n") || "- none";

  return [
    "You are an autonomous agent whose goal is to generate money.",
    "Choose exactly ONE concrete monetisation action for this run.",
    "",
    "Allowed actions:",
    "- create a micro-product idea and draft listing title",
    "- create a small dataset product idea and draft listing title",
    "- create a product outline",
    "- create a product description",
    "- create a listing draft",
    "- create a blocked task for human intervention if truly required",
    "",
    "Do not brainstorm broadly.",
    "Do not return multiple options.",
    "Do not return markdown.",
    "Return raw JSON only.",
    "",
    "Return exactly this schema:",
    "{",
    '  "action": "string",',
    '  "status": "completed" | "blocked_waiting_for_human",',
    '  "reason": "string",',
    '  "task": null | {',
    '    "title": "string",',
    '    "details": "string",',
    '    "priority": "low" | "medium" | "high"',
    "  }",
    "}",
    "",
    `Agent: ${agentState.name}`,
    `Strategy: ${agentState.strategy}`,
    `Revenue: ${agentState.revenue}`,
    `Cost: ${agentState.cost}`,
    `Recent messages:\n${recentMessages}`,
    `Open tasks:\n${openTasks}`,
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

  let rawGeminiText = "";
  let parsedDecision: any = null;
  let finalDecision: any;
  let runError: any = null;
  let nextTasks = tasks;

  try {
    const prompt = buildPrompt(agentState, messages, tasks, config);
    rawGeminiText = await callGemini(prompt, {
      timeoutMs: config.geminiTimeoutMs || 20000
    });
    parsedDecision = extractJson(rawGeminiText);
    finalDecision = isValidDecisionShape(parsedDecision) ? sanitizeDecision(parsedDecision) : FALLBACK_DECISION;
  } catch (error: any) {
    runError = error;
    finalDecision = {
      action: "none",
      status: "blocked_waiting_for_human",
      reason: "Gemini API failure",
      task: null
    };
  }

  const now = new Date().toISOString();
  const profit = Number((agentState.revenue - agentState.cost).toFixed(2));

  agentState.lastAction = finalDecision.action;
  agentState.lastReason = finalDecision.reason;
  agentState.lastRunAt = now;
  agentState.status = finalDecision.status;
  agentState.profit = profit;

  writeJson(agentFile, agentState);

  const nextMessages = readJson<any[]>(messagesPath, []);
  nextMessages.push({
    timestamp: now,
    agent: agentState.name,
    type: finalDecision.status,
    message: `${finalDecision.action} (${finalDecision.reason})`.slice(0, 500)
  });
  writeJson(messagesPath, nextMessages);

  if (
    finalDecision.status === "blocked_waiting_for_human" &&
    finalDecision.task &&
    !hasOpenTask(tasks, agentState.name, finalDecision.task.title)
  ) {
    const taskEntry = {
      id: `${agentState.name}-${Date.now()}`,
      createdAt: now,
      agent: agentState.name,
      title: finalDecision.task.title,
      details: finalDecision.task.details,
      priority: finalDecision.task.priority,
      reason: finalDecision.reason,
      status: "open"
    };
    nextTasks = [...tasks, taskEntry];
    writeJson(tasksPath, nextTasks);
  }

  const logEntry = {
    timestamp: now,
    agent: agentState.name,
    rawGeminiText: rawGeminiText.slice(0, 2000),
    parsedObject: parsedDecision,
    finalObject: finalDecision,
    action: finalDecision.action,
    status: finalDecision.status,
    reason: finalDecision.reason,
    finalStatus: finalDecision.status,
    profit,
    errorMessage: runError ? String(runError.message || runError).slice(0, 500) : ""
  };

  fs.writeFileSync(path.join(LOGS_DIR, `${agentState.name}-${Date.now()}.json`), `${JSON.stringify(logEntry, null, 2)}\n`, "utf8");

  console.log(`[worker] parsed object: ${JSON.stringify(parsedDecision)}`);
  console.log(`[worker] final object: ${JSON.stringify(finalDecision)}`);
  console.log(`[worker] ${agentName} -> ${finalDecision.status}: ${finalDecision.action}`);

  if (runError) {
    console.log(`[worker] ${agentName} error handled: ${runError.message}`);
  }
}

run().catch((error) => {
  console.error("[worker] Fatal error:", error);
  process.exit(1);
});
