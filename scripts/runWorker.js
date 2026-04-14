const fs = require("fs");
const path = require("path");
const { callGemini } = require("./gemini");

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const MESSAGES_PATH = path.join(STATE_DIR, "messages.json");
const TASKS_PATH = path.join(STATE_DIR, "tasks.json");

const FALLBACK_INVALID_MODEL_OUTPUT = {
  action: "none",
  status: "blocked_waiting_for_human",
  reason: "Invalid model output",
  task: null
};

const FALLBACK_RUNTIME_FAILURE = {
  action: "none",
  status: "blocked_waiting_for_human",
  reason: "Runtime failure",
  task: null
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function trimString(value, maxLength) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").slice(0, maxLength);
}

function defaultAgentState(agentName) {
  return {
    name: agentName,
    strategy: "generate digital products",
    revenue: 0,
    cost: 0,
    lastAction: "",
    status: "idle"
  };
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
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function safeReadArray(filePath) {
  try {
    const value = readJson(filePath, []);
    return Array.isArray(value) ? value : [];
  } catch (_error) {
    writeJson(filePath, []);
    return [];
  }
}

function safeReadConfig() {
  try {
    return readJson(path.join(STATE_DIR, "config.json"), {});
  } catch (_error) {
    return {};
  }
}

function getAgentFile(agentName) {
  return path.join(AGENTS_DIR, `${agentName}.json`);
}

function ensureAgentState(agentName, trace) {
  const agentFile = getAgentFile(agentName);
  const fallback = defaultAgentState(agentName);

  try {
    const state = readJson(agentFile, fallback);

    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("Agent state must be a JSON object.");
    }

    const normalized = {
      ...fallback,
      ...state,
      name: agentName,
      strategy: trimString(state.strategy || fallback.strategy, 200) || fallback.strategy,
      revenue: Number.isFinite(Number(state.revenue)) ? Number(state.revenue) : 0,
      cost: Number.isFinite(Number(state.cost)) ? Number(state.cost) : 0,
      lastAction: trimString(state.lastAction || "", 280),
      status: trimString(state.status || fallback.status, 60) || fallback.status
    };

    writeJson(agentFile, normalized);
    trace.push("load:agent-state-ready");
    return normalized;
  } catch (error) {
    trace.push(`load:agent-state-reset:${error.message}`);
    writeJson(agentFile, fallback);
    return fallback;
  }
}

function hasOpenTask(tasks, agentName, taskTitle) {
  return tasks.some((task) => task.agent === agentName && (task.title || task.task) === taskTitle && task.status !== "done");
}

function extractJson(text) {
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

  try {
    return JSON.parse(candidate.slice(startIndex, endIndex + 1));
  } catch (_error) {
    return null;
  }
}

function isValidTask(task) {
  return Boolean(
    task &&
      typeof task === "object" &&
      typeof task.title === "string" &&
      typeof task.details === "string" &&
      ["low", "medium", "high"].includes(task.priority)
  );
}

function isValidDecisionShape(decision) {
  return Boolean(
    decision &&
      typeof decision === "object" &&
      typeof decision.action === "string" &&
      typeof decision.reason === "string" &&
      ["completed", "blocked_waiting_for_human"].includes(decision.status) &&
      (decision.task === null || isValidTask(decision.task))
  );
}

function sanitizeDecision(decision) {
  const task = isValidTask(decision?.task)
    ? {
        title: trimString(decision.task.title, 140),
        details: trimString(decision.task.details, 500),
        priority: decision.task.priority
      }
    : null;

  return {
    action: trimString(decision?.action || "none", 280) || "none",
    status: decision?.status === "blocked_waiting_for_human" ? "blocked_waiting_for_human" : "completed",
    reason: trimString(decision?.reason || "", 500) || "Invalid model output",
    task
  };
}

function buildPrompt(agentState, messages, tasks, config) {
  const recentMessages = messages.slice(-3).map((entry) => `- ${entry.agent}: ${entry.message}`).join("\n") || "- none";
  const openTasks = tasks
    .filter((task) => task.status !== "done")
    .slice(-3)
    .map((task) => `- ${task.agent}: ${task.title || task.task}`)
    .join("\n") || "- none";

  const prompt = [
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
    `Agent: ${trimString(agentState.name, 80) || "agent"}`,
    `Strategy: ${trimString(agentState.strategy, 200) || "generate digital products"}`,
    `Revenue: ${Number(agentState.revenue || 0)}`,
    `Cost: ${Number(agentState.cost || 0)}`,
    `Recent messages:\n${recentMessages}`,
    `Open tasks:\n${openTasks}`,
    `Keep it short and practical. Max ${config.maxActionChars || 140} chars for action.`
  ].join("\n");

  return trimString(prompt, 6000);
}

function writeLog(agentName, payload) {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${agentName}-${Date.now()}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function persistRun(agentState, messages, tasks, finalDecision, metadata) {
  const now = new Date().toISOString();
  const profit = Number((Number(agentState.revenue || 0) - Number(agentState.cost || 0)).toFixed(2));
  const nextAgentState = {
    ...agentState,
    lastAction: finalDecision.action,
    lastReason: finalDecision.reason,
    lastRunAt: now,
    status: finalDecision.status,
    profit
  };

  writeJson(getAgentFile(agentState.name), nextAgentState);

  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  nextMessages.push({
    timestamp: now,
    agent: agentState.name,
    type: finalDecision.status,
    message: `${finalDecision.action} (${finalDecision.reason})`.slice(0, 500)
  });
  writeJson(MESSAGES_PATH, nextMessages);

  let nextTasks = Array.isArray(tasks) ? [...tasks] : [];
  if (
    finalDecision.status === "blocked_waiting_for_human" &&
    finalDecision.task &&
    !hasOpenTask(nextTasks, agentState.name, finalDecision.task.title)
  ) {
    nextTasks.push({
      id: `${agentState.name}-${Date.now()}`,
      createdAt: now,
      agent: agentState.name,
      title: finalDecision.task.title,
      details: finalDecision.task.details,
      priority: finalDecision.task.priority,
      reason: finalDecision.reason,
      status: "open"
    });
  }
  writeJson(TASKS_PATH, nextTasks);

  writeLog(agentState.name, {
    timestamp: now,
    agent: agentState.name,
    steps: metadata.trace,
    stepReached: metadata.stepReached,
    geminiResponseStatus: metadata.geminiResponseStatus,
    rawGeminiText: trimString(metadata.rawGeminiText || "", 2000),
    parsedObject: metadata.parsedObject,
    finalObject: finalDecision,
    finalStatus: finalDecision.status,
    errorMessage: metadata.error ? trimString(metadata.error.message || metadata.error, 500) : "",
    errorStack: metadata.error?.stack ? String(metadata.error.stack).slice(0, 4000) : "",
    profit
  });

  return nextAgentState;
}

async function runWorker(agentName) {
  const trace = [];
  let stepReached = "start";
  let geminiResponseStatus = null;
  let rawGeminiText = "";
  let parsedObject = null;
  let agentState = defaultAgentState(agentName);
  let messages = [];
  let tasks = [];

  try {
    ensureDir(LOGS_DIR);
    trace.push(`start:${agentName}`);

    stepReached = "load";
    trace.push("load");
    const config = safeReadConfig();
    agentState = ensureAgentState(agentName, trace);
    messages = safeReadArray(MESSAGES_PATH);
    tasks = safeReadArray(TASKS_PATH);

    stepReached = "prompt";
    trace.push("prompt");
    const prompt = buildPrompt(agentState, messages, tasks, config);
    if (!prompt || !prompt.trim()) {
      throw new Error("Generated prompt is empty.");
    }

    stepReached = "gemini";
    trace.push("gemini");
    const geminiResult = await callGemini(prompt, {
      timeoutMs: config.geminiTimeoutMs || 20000
    });
    rawGeminiText = typeof geminiResult?.text === "string" ? geminiResult.text : "";
    geminiResponseStatus = geminiResult?.status ?? null;

    stepReached = "parse";
    trace.push("parse");
    parsedObject = extractJson(rawGeminiText);
    const finalDecision = isValidDecisionShape(parsedObject)
      ? sanitizeDecision(parsedObject)
      : FALLBACK_INVALID_MODEL_OUTPUT;

    stepReached = "save";
    trace.push("save");
    const nextAgentState = persistRun(agentState, messages, tasks, finalDecision, {
      trace,
      stepReached,
      geminiResponseStatus,
      rawGeminiText,
      parsedObject,
      error: null
    });

    console.log(`[worker] agent=${agentName}`);
    console.log(`[worker] steps=${trace.join(" -> ")}`);
    console.log(`[worker] gemini.status=${geminiResponseStatus}`);
    console.log(`[worker] parsed=${JSON.stringify(parsedObject)}`);
    console.log(`[worker] final=${JSON.stringify(finalDecision)}`);
    console.log(`[worker] saved=${nextAgentState.status}`);
    return finalDecision;
  } catch (error) {
    trace.push(`error:${stepReached}`);

    const fallbackDecision = { ...FALLBACK_RUNTIME_FAILURE };
    try {
      stepReached = "save";
      trace.push("save");
      persistRun(agentState, messages, tasks, fallbackDecision, {
        trace,
        stepReached,
        geminiResponseStatus,
        rawGeminiText,
        parsedObject,
        error
      });
    } catch (persistError) {
      console.error("[worker] Failed to persist fallback state:", persistError);
    }

    console.error(`[worker] agent=${agentName}`);
    console.error(`[worker] steps=${trace.join(" -> ")}`);
    console.error(`[worker] gemini.status=${geminiResponseStatus}`);
    console.error(`[worker] error.message=${error.message}`);
    console.error(`[worker] error.stack=${error.stack || ""}`);
    return fallbackDecision;
  }
}

async function main() {
  const agentName = process.argv[2];

  if (!agentName) {
    console.error("[worker] Missing agent name. Usage: node scripts/runWorker.js <agent-name>");
    return;
  }

  const result = await runWorker(agentName);
  console.log(`[worker] result=${JSON.stringify(result)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[worker] Unhandled main error:", error);
  });
}

module.exports = {
  runWorker,
  extractJson
};
