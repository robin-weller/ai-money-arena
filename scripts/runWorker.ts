import fs from "fs";
import path from "path";
import { callGemini } from "./gemini";

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const OUTPUTS_DIR = path.join(ROOT_DIR, "outputs");
const MESSAGES_PATH = path.join(STATE_DIR, "messages.json");
const TASKS_PATH = path.join(STATE_DIR, "tasks.json");

function defaultCompletedFields() {
  return {
    productTitle: "",
    productType: "",
    niche: "",
    targetBuyer: "",
    listingTitle: "",
    shortDescription: "",
    priceSuggestion: "",
    fileContent: "",
    confidence: 0
  };
}

const FALLBACK_INVALID_MODEL_OUTPUT = {
  action: "none",
  status: "blocked_waiting_for_human",
  reason: "Invalid model output",
  task: null,
  ...defaultCompletedFields()
} as const;

const FALLBACK_RUNTIME_FAILURE = {
  action: "none",
  status: "blocked_waiting_for_human",
  reason: "Runtime failure",
  task: null,
  ...defaultCompletedFields()
} as const;

type TaskPayload = {
  title: string;
  details: string;
  priority: "low" | "medium" | "high";
};

type WorkerDecision = {
  action: string;
  status: "completed" | "blocked_waiting_for_human";
  reason: string;
  task: TaskPayload | null;
  productTitle: string;
  productType: string;
  niche: string;
  targetBuyer: string;
  listingTitle: string;
  shortDescription: string;
  priceSuggestion: string;
  fileContent: string;
  confidence: number;
};

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function trimString(value: unknown, maxLength: number): string {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").slice(0, maxLength);
}

function normalizeComparisonText(value: unknown): string {
  return trimString(value || "", 240)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultAgentState(agentName: string) {
  return {
    name: agentName,
    strategy: "generate digital products",
    revenue: 0,
    cost: 0,
    lastAction: "",
    status: "idle",
    lastProductType: "",
    lastNiche: "",
    lastTargetBuyer: "",
    lastProductTitle: "",
    lastListingTitle: "",
    lastOutputPath: "",
    lastConfidence: 0,
    lastDuplicateStatus: "original",
    attempts: 0,
    uniqueNichesTried: [],
    duplicateHits: 0,
    successfulOutputs: 0
  };
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
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function safeReadArray(filePath: string): any[] {
  try {
    const value = readJson<any>(filePath, []);
    return Array.isArray(value) ? value : [];
  } catch (_error: any) {
    writeJson(filePath, []);
    return [];
  }
}

function safeReadConfig(): Record<string, any> {
  try {
    return readJson<Record<string, any>>(path.join(STATE_DIR, "config.json"), {});
  } catch (_error: any) {
    return {};
  }
}

function getAgentFile(agentName: string): string {
  return path.join(AGENTS_DIR, `${agentName}.json`);
}

function ensureAgentState(agentName: string, trace: string[]) {
  const agentFile = getAgentFile(agentName);
  const fallback = defaultAgentState(agentName);

  try {
    const state = readJson<any>(agentFile, fallback);

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
      status: trimString(state.status || fallback.status, 60) || fallback.status,
      lastProductType: trimString(state.lastProductType || "", 120),
      lastNiche: trimString(state.lastNiche || "", 160),
      lastTargetBuyer: trimString(state.lastTargetBuyer || "", 200),
      lastProductTitle: trimString(state.lastProductTitle || "", 200),
      lastListingTitle: trimString(state.lastListingTitle || "", 220),
      lastOutputPath: trimString(state.lastOutputPath || "", 260),
      lastConfidence: Number.isFinite(Number(state.lastConfidence)) ? Number(state.lastConfidence) : 0,
      lastDuplicateStatus: trimString(state.lastDuplicateStatus || "original", 40) || "original",
      attempts: Number.isFinite(Number(state.attempts)) ? Number(state.attempts) : 0,
      uniqueNichesTried: Array.isArray(state.uniqueNichesTried)
        ? state.uniqueNichesTried.map((item: unknown) => trimString(item, 160)).filter(Boolean)
        : [],
      duplicateHits: Number.isFinite(Number(state.duplicateHits)) ? Number(state.duplicateHits) : 0,
      successfulOutputs: Number.isFinite(Number(state.successfulOutputs)) ? Number(state.successfulOutputs) : 0
    };

    writeJson(agentFile, normalized);
    trace.push("load:agent-state-ready");
    return normalized;
  } catch (error: any) {
    trace.push(`load:agent-state-reset:${error.message}`);
    writeJson(agentFile, fallback);
    return fallback;
  }
}

function hasOpenTask(tasks: any[], agentName: string, taskTitle: string): boolean {
  return tasks.some((task) => task.agent === agentName && (task.title || task.task) === taskTitle && task.status !== "done");
}

export function extractJson(text: string): object | null {
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
  } catch (_error: any) {
    return null;
  }
}

function isValidTask(task: any): task is TaskPayload {
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
      typeof decision.productTitle === "string" &&
      typeof decision.productType === "string" &&
      typeof decision.niche === "string" &&
      typeof decision.targetBuyer === "string" &&
      typeof decision.listingTitle === "string" &&
      typeof decision.shortDescription === "string" &&
      typeof decision.priceSuggestion === "string" &&
      typeof decision.fileContent === "string" &&
      typeof decision.confidence === "number" &&
      decision.confidence >= 0 &&
      decision.confidence <= 1 &&
      (decision.task === null || isValidTask(decision.task))
  );
}

function sanitizeDecision(decision: any): WorkerDecision {
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
    task,
    productTitle: trimString(decision?.productTitle || "", 200),
    productType: trimString(decision?.productType || "", 120),
    niche: trimString(decision?.niche || "", 160),
    targetBuyer: trimString(decision?.targetBuyer || "", 200),
    listingTitle: trimString(decision?.listingTitle || "", 220),
    shortDescription: trimString(decision?.shortDescription || "", 500),
    priceSuggestion: trimString(decision?.priceSuggestion || "", 80),
    fileContent: trimString(decision?.fileContent || "", 5000),
    confidence: Math.max(0, Math.min(1, Number(decision?.confidence || 0)))
  };
}

function collectLatestOutputs(currentAgentName: string): any[] {
  if (!fs.existsSync(OUTPUTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(OUTPUTS_DIR)
    .filter((entry) => entry !== currentAgentName)
    .map((entry) => path.join(OUTPUTS_DIR, entry, "latest.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => readJson<any>(filePath, null))
    .filter(Boolean);
}

function compareOverlap(a: unknown, b: unknown): number {
  const left = new Set(normalizeComparisonText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeComparisonText(b).split(" ").filter(Boolean));

  if (!left.size || !right.size) {
    return 0;
  }

  let shared = 0;
  for (const item of left) {
    if (right.has(item)) {
      shared += 1;
    }
  }

  return shared / Math.max(left.size, right.size);
}

function isSimilarToOutput(candidate: WorkerDecision, other: any): boolean {
  const sameType = normalizeComparisonText(candidate.productType) === normalizeComparisonText(other.productType);
  const sameNiche = normalizeComparisonText(candidate.niche) === normalizeComparisonText(other.niche);
  const sameBuyer = normalizeComparisonText(candidate.targetBuyer) === normalizeComparisonText(other.targetBuyer);
  const titleOverlap = compareOverlap(candidate.productTitle, other.productTitle);
  return Boolean((sameType && sameNiche) || (sameNiche && sameBuyer) || titleOverlap >= 0.7);
}

function isVagueOutput(decision: WorkerDecision): boolean {
  return (
    normalizeComparisonText(decision.productTitle).length < 8 ||
    normalizeComparisonText(decision.niche).length < 4 ||
    normalizeComparisonText(decision.targetBuyer).length < 6 ||
    normalizeComparisonText(decision.fileContent).length < 40
  );
}

function isPureBrainstorming(decision: WorkerDecision): boolean {
  const action = normalizeComparisonText(decision.action);
  return action.includes("brainstorm") || action.includes("multiple options") || action.includes("list ideas");
}

function matchesPreviousRun(decision: WorkerDecision, agentState: any): boolean {
  return (
    normalizeComparisonText(decision.productTitle) === normalizeComparisonText(agentState.lastProductTitle) &&
    normalizeComparisonText(decision.productType) === normalizeComparisonText(agentState.lastProductType) &&
    normalizeComparisonText(decision.niche) === normalizeComparisonText(agentState.lastNiche) &&
    normalizeComparisonText(decision.targetBuyer) === normalizeComparisonText(agentState.lastTargetBuyer)
  );
}

function hasProgress(decision: WorkerDecision, agentState: any): boolean {
  if (!agentState.lastProductTitle) {
    return true;
  }

  const reason = normalizeComparisonText(decision.reason);
  return !matchesPreviousRun(decision, agentState) || reason.includes("pivot") || reason.includes("build") || reason.includes("continue");
}

function classifyDuplicate(candidate: WorkerDecision, otherOutputs: any[]): { isDuplicate: boolean; duplicateWith: string } {
  const match = otherOutputs.find((other) => isSimilarToOutput(candidate, other));
  return {
    isDuplicate: Boolean(match),
    duplicateWith: match ? match.agent || "" : ""
  };
}

function buildPrompt(
  agentState: any,
  messages: any[],
  tasks: any[],
  config: Record<string, any>,
  options: { latestOutputsText?: string; retryInstruction?: string } = {}
): string {
  const recentMessages = messages.slice(-3).map((entry) => `- ${entry.agent}: ${entry.message}`).join("\n") || "- none";
  const openTasks = tasks
    .filter((task) => task.status !== "done")
    .slice(-3)
    .map((task) => `- ${task.agent}: ${task.title || task.task}`)
    .join("\n") || "- none";

  const prompt = [
    "You are an autonomous agent whose goal is to generate money.",
    "Choose exactly ONE concrete monetisation action for this run.",
    "You must either build on your previous output with a concrete improvement or pivot with a clear reason.",
    "",
    "Allowed actions:",
    "- create a micro-product idea and draft listing title",
    "- create a small dataset idea and draft listing title",
    "- create a product outline",
    "- create a product description",
    "- create a listing draft",
    "- create a blocked task for human intervention if truly required",
    "",
    "Allowed product examples:",
    "- prompt pack",
    "- checklist",
    "- template pack",
    "- small dataset idea",
    "- mini guide",
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
    "  },",
    '  "productTitle": "string",',
    '  "productType": "string",',
    '  "niche": "string",',
    '  "targetBuyer": "string",',
    '  "listingTitle": "string",',
    '  "shortDescription": "string",',
    '  "priceSuggestion": "string",',
    '  "fileContent": "string",',
    '  "confidence": 0-1',
    "}",
    "",
    `Agent: ${trimString(agentState.name, 80) || "agent"}`,
    `Strategy: ${trimString(agentState.strategy, 200) || "generate digital products"}`,
    `Previous product title: ${trimString(agentState.lastProductTitle || "none", 200)}`,
    `Previous product type: ${trimString(agentState.lastProductType || "none", 120)}`,
    `Previous niche: ${trimString(agentState.lastNiche || "none", 160)}`,
    `Previous target buyer: ${trimString(agentState.lastTargetBuyer || "none", 200)}`,
    `Revenue: ${Number(agentState.revenue || 0)}`,
    `Cost: ${Number(agentState.cost || 0)}`,
    `Recent messages:\n${recentMessages}`,
    `Open tasks:\n${openTasks}`,
    options.latestOutputsText ? `Other agents latest outputs:\n${options.latestOutputsText}` : "Other agents latest outputs:\n- none",
    options.retryInstruction || "",
    `Keep it short and practical. Max ${config.maxActionChars || 140} chars for action.`
  ].join("\n");

  return trimString(prompt, 7000);
}

function writeLog(agentName: string, payload: unknown): void {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${agentName}-${Date.now()}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function saveOutput(agentName: string, now: string, finalDecision: WorkerDecision): string {
  if (finalDecision.status !== "completed") {
    return "";
  }

  const agentOutputDir = path.join(OUTPUTS_DIR, agentName);
  ensureDir(agentOutputDir);
  const fileName = `${now.replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(agentOutputDir, fileName);
  const outputPayload = {
    generatedAt: now,
    agent: agentName,
    productTitle: finalDecision.productTitle,
    productType: finalDecision.productType,
    niche: finalDecision.niche,
    targetBuyer: finalDecision.targetBuyer,
    listingTitle: finalDecision.listingTitle,
    shortDescription: finalDecision.shortDescription,
    priceSuggestion: finalDecision.priceSuggestion,
    fileContent: finalDecision.fileContent,
    confidence: finalDecision.confidence,
    action: finalDecision.action,
    reason: finalDecision.reason
  };

  writeJson(outputPath, outputPayload);
  writeJson(path.join(agentOutputDir, "latest.json"), outputPayload);
  return path.relative(ROOT_DIR, outputPath);
}

function persistRun(agentState: any, messages: any[], tasks: any[], finalDecision: WorkerDecision, metadata: any) {
  const now = new Date().toISOString();
  const profit = Number((Number(agentState.revenue || 0) - Number(agentState.cost || 0)).toFixed(2));
  const latestTask = finalDecision.status === "blocked_waiting_for_human" && finalDecision.task ? finalDecision.task : null;
  const outputPath = saveOutput(agentState.name, now, finalDecision);
  const previousNiches = Array.isArray(agentState.uniqueNichesTried) ? [...agentState.uniqueNichesTried] : [];
  const nextUniqueNiches =
    finalDecision.status === "completed" && finalDecision.niche && !previousNiches.includes(finalDecision.niche)
      ? [...previousNiches, finalDecision.niche]
      : previousNiches;

  const nextAgentState = {
    ...agentState,
    lastAction: finalDecision.action,
    lastReason: finalDecision.reason,
    lastProductTitle: finalDecision.status === "completed" ? finalDecision.productTitle : "",
    lastProductType: finalDecision.status === "completed" ? finalDecision.productType : "",
    lastNiche: finalDecision.status === "completed" ? finalDecision.niche : "",
    lastTargetBuyer: finalDecision.status === "completed" ? finalDecision.targetBuyer : "",
    lastListingTitle: finalDecision.status === "completed" ? finalDecision.listingTitle : "",
    lastOutputPath: outputPath,
    lastConfidence: finalDecision.confidence || 0,
    lastDuplicateStatus: metadata.duplicateStatus || "original",
    lastRunAt: now,
    status: finalDecision.status,
    latestTask,
    revenue: Number(agentState.revenue || 0),
    cost: Number(agentState.cost || 0),
    profit,
    attempts: Number(agentState.attempts || 0) + 1,
    uniqueNichesTried: nextUniqueNiches,
    duplicateHits: Number(agentState.duplicateHits || 0) + (metadata.duplicateStatus === "duplicate" ? 1 : 0),
    successfulOutputs: Number(agentState.successfulOutputs || 0) + (finalDecision.status === "completed" ? 1 : 0)
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
  nextTasks = nextTasks.filter((task) => task.agent !== agentState.name);

  if (latestTask && !hasOpenTask(nextTasks, agentState.name, latestTask.title)) {
    nextTasks.push({
      id: `${agentState.name}-${Date.now()}`,
      createdAt: now,
      agent: agentState.name,
      title: latestTask.title,
      details: latestTask.details,
      priority: latestTask.priority,
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
    productTitle: finalDecision.productTitle || "",
    productType: finalDecision.productType || "",
    niche: finalDecision.niche || "",
    targetBuyer: finalDecision.targetBuyer || "",
    listingTitle: finalDecision.listingTitle || "",
    confidence: finalDecision.confidence || 0,
    duplicateStatus: metadata.duplicateStatus || "original",
    outputPath,
    finalStatus: finalDecision.status,
    errorMessage: metadata.error ? trimString(metadata.error.message || metadata.error, 500) : "",
    errorStack: metadata.error?.stack ? String(metadata.error.stack).slice(0, 4000) : "",
    profit
  });

  return nextAgentState;
}

export async function runWorker(agentName: string): Promise<WorkerDecision> {
  const trace: string[] = [];
  let stepReached = "start";
  let geminiResponseStatus: number | null = null;
  let rawGeminiText = "";
  let parsedObject: any = null;
  let duplicateStatus = "original";
  let agentState: any = defaultAgentState(agentName);
  let messages: any[] = [];
  let tasks: any[] = [];

  try {
    ensureDir(LOGS_DIR);
    trace.push(`start:${agentName}`);

    stepReached = "load";
    trace.push("load");
    const config = safeReadConfig();
    agentState = ensureAgentState(agentName, trace);
    messages = safeReadArray(MESSAGES_PATH);
    tasks = safeReadArray(TASKS_PATH);
    const latestOutputs = collectLatestOutputs(agentName);
    const latestOutputsText =
      latestOutputs
        .map((item) => `- ${item.agent}: ${item.productTitle} | ${item.productType} | ${item.niche} | ${item.targetBuyer}`)
        .join("\n") || "- none";

    stepReached = "prompt";
    trace.push("prompt");
    let prompt = buildPrompt(agentState, messages, tasks, config, { latestOutputsText });
    if (!prompt || !prompt.trim()) {
      throw new Error("Generated prompt is empty.");
    }

    stepReached = "gemini";
    trace.push("gemini");
    let finalDecision: WorkerDecision = { ...FALLBACK_INVALID_MODEL_OUTPUT };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const geminiResult = await callGemini(prompt, {
        timeoutMs: config.geminiTimeoutMs || 20000
      });
      rawGeminiText = typeof geminiResult?.text === "string" ? geminiResult.text : "";
      geminiResponseStatus = geminiResult?.status ?? null;

      stepReached = "parse";
      trace.push(`parse:${attempt + 1}`);
      parsedObject = extractJson(rawGeminiText);
      finalDecision = isValidDecisionShape(parsedObject) ? sanitizeDecision(parsedObject) : { ...FALLBACK_INVALID_MODEL_OUTPUT };

      const progressOkay =
        finalDecision.status !== "completed" ||
        (hasProgress(finalDecision, agentState) && !isVagueOutput(finalDecision) && !isPureBrainstorming(finalDecision));
      const duplicateCheck =
        finalDecision.status === "completed" ? classifyDuplicate(finalDecision, latestOutputs) : { isDuplicate: false, duplicateWith: "" };

      if (finalDecision.status === "completed" && progressOkay && !duplicateCheck.isDuplicate) {
        duplicateStatus = "original";
        break;
      }

      if (finalDecision.status === "completed" && duplicateCheck.isDuplicate && attempt === 0) {
        duplicateStatus = "retry";
        prompt = buildPrompt(agentState, messages, tasks, config, {
          latestOutputsText,
          retryInstruction: `Retry once. Your last output was too similar to ${duplicateCheck.duplicateWith || "another agent"}. Choose a different niche or product type and return a distinct sellable draft.`
        });
        continue;
      }

      if (finalDecision.status === "completed" && duplicateCheck.isDuplicate) {
        duplicateStatus = "duplicate";
        finalDecision.confidence = Math.min(finalDecision.confidence || 0.35, 0.35);
        finalDecision.reason = trimString(`${finalDecision.reason} Duplicate risk remained after retry.`, 500);
      } else if (finalDecision.status === "completed" && !progressOkay) {
        finalDecision = {
          ...FALLBACK_INVALID_MODEL_OUTPUT,
          reason: "Invalid model output"
        };
        duplicateStatus = "original";
      }
      break;
    }

    stepReached = "save";
    trace.push("save");
    const nextAgentState = persistRun(agentState, messages, tasks, finalDecision, {
      trace,
      stepReached,
      geminiResponseStatus,
      rawGeminiText,
      parsedObject,
      duplicateStatus,
      error: null
    });

    console.log(`[worker] agent=${agentName}`);
    console.log(`[worker] steps=${trace.join(" -> ")}`);
    console.log(`[worker] gemini.status=${geminiResponseStatus}`);
    console.log(`[worker] parsed=${JSON.stringify(parsedObject)}`);
    console.log(`[worker] final=${JSON.stringify(finalDecision)}`);
    console.log(`[worker] duplicateStatus=${duplicateStatus}`);
    console.log(`[worker] output=${nextAgentState.lastOutputPath || ""}`);
    console.log(`[worker] saved=${nextAgentState.status}`);
    return finalDecision;
  } catch (error: any) {
    trace.push(`error:${stepReached}`);

    const fallbackDecision: WorkerDecision = { ...FALLBACK_RUNTIME_FAILURE };
    try {
      stepReached = "save";
      trace.push("save");
      persistRun(agentState, messages, tasks, fallbackDecision, {
        trace,
        stepReached,
        geminiResponseStatus,
        rawGeminiText,
        parsedObject,
        duplicateStatus,
        error
      });
    } catch (persistError: any) {
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

async function main(): Promise<void> {
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
