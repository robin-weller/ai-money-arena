const fs = require("fs");
const path = require("path");
const { callGemini } = require("./gemini");

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function appendJsonArray(filePath, entry) {
  const items = readJson(filePath, []);
  items.push(entry);
  writeJson(filePath, items);
}

function hasOpenTask(tasks, agentName, taskTitle) {
  return tasks.some((task) => task.agent === agentName && task.task === taskTitle && task.status !== "done");
}

function sanitizeDecision(decision) {
  return {
    action: String(decision?.action || "none").slice(0, 280),
    status: decision?.status === "blocked_waiting_for_human" ? "blocked_waiting_for_human" : "completed",
    reason: String(decision?.reason || "").slice(0, 500),
    task: typeof decision?.task === "string" ? decision.task.slice(0, 280) : ""
  };
}

function getAgentFile(agentName) {
  return path.join(AGENTS_DIR, `${agentName}.json`);
}

function buildPrompt(agentState, messages, tasks, config) {
  const recentMessages = messages.slice(-3).map((entry) => `- ${entry.agent}: ${entry.message}`).join("\n") || "- none";
  const openTasks = tasks
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

async function run() {
  const agentName = process.argv[2];

  if (!agentName) {
    throw new Error("Usage: node scripts/runWorker.js <agent-name>");
  }

  ensureDir(LOGS_DIR);

  const config = readJson(path.join(STATE_DIR, "config.json"), {});
  const agentFile = getAgentFile(agentName);
  const agentState = readJson(agentFile);
  const messagesPath = path.join(STATE_DIR, "messages.json");
  const tasksPath = path.join(STATE_DIR, "tasks.json");
  const messages = readJson(messagesPath, []);
  const tasks = readJson(tasksPath, []);

  console.log(`[worker] Running ${agentName}`);

  let decision;
  let runError = null;
  let nextTasks = tasks;

  try {
    const prompt = buildPrompt(agentState, messages, tasks, config);
    const geminiDecision = await callGemini(prompt, {
      timeoutMs: config.geminiTimeoutMs || 20000
    });
    decision = sanitizeDecision(geminiDecision);
  } catch (error) {
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

  fs.writeFileSync(
    path.join(LOGS_DIR, `${agentState.name}-${Date.now()}.json`),
    `${JSON.stringify(logEntry, null, 2)}\n`,
    "utf8"
  );

  console.log(`[worker] ${agentName} -> ${decision.status}: ${decision.action}`);

  if (runError) {
    console.log(`[worker] ${agentName} error handled: ${runError.message}`);
  }
}

run().catch((error) => {
  console.error("[worker] Fatal error:", error);
  process.exit(1);
});
