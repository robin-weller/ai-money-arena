const fs = require("fs");
const path = require("path");
const { callGemini } = require("./gemini");

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
    price: 0,
    description: "",
    bullets: [],
    publishInstructions: "",
    fileContent: "",
    confidence: 0
  };
}

const FALLBACK_INVALID_MODEL_OUTPUT = {
  action: "retry_next_run",
  status: "completed",
  reason: "Model failed to produce valid output, will retry next cycle",
  task: null,
  ...defaultCompletedFields()
};

const FALLBACK_RUNTIME_FAILURE = {
  action: "retry_next_run",
  status: "completed",
  reason: "Runtime failure, will retry next cycle",
  task: null,
  ...defaultCompletedFields()
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function trimString(value, maxLength) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").slice(0, maxLength);
}

function normalizeComparisonText(value) {
  return trimString(value || "", 240)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultAgentState(agentName) {
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
    lastPrice: 0,
    lastOutputPath: "",
    lastConfidence: 0,
    lastDuplicateStatus: "original",
    stage: "idea",
    lastProgressMode: "progressing",
    attempts: 0,
    uniqueNichesTried: [],
    duplicateHits: 0,
    successfulOutputs: 0
  };
}

function normalizeStage(stage) {
  return ["idea", "outline", "content", "listing", "publish"].includes(stage) ? stage : "idea";
}

function nextStage(currentStage) {
  if (currentStage === "idea") {
    return "outline";
  }
  if (currentStage === "outline") {
    return "content";
  }
  if (currentStage === "content") {
    return "listing";
  }
  if (currentStage === "listing") {
    return "publish";
  }
  return "publish";
}

function getStageGoal(stage) {
  if (stage === "idea") {
    return "Create a concrete product idea and draft listing title.";
  }
  if (stage === "outline") {
    return "Expand the existing product into a clear outline with sections, components, or structure.";
  }
  if (stage === "content") {
    return "Generate real usable product content with no placeholders.";
  }
  if (stage === "listing") {
    return "Create a publish-ready listing with price, benefits, Gumroad instructions, and a human approval task.";
  }
  return "Keep the product publish-ready with final Gumroad instructions and a human approval task.";
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
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
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
      status: trimString(state.status || fallback.status, 60) || fallback.status,
      lastProductType: trimString(state.lastProductType || "", 120),
      lastNiche: trimString(state.lastNiche || "", 160),
      lastTargetBuyer: trimString(state.lastTargetBuyer || "", 200),
      lastProductTitle: trimString(state.lastProductTitle || "", 200),
      lastListingTitle: trimString(state.lastListingTitle || "", 220),
      lastPrice: Number.isFinite(Number(state.lastPrice)) ? Number(state.lastPrice) : 0,
      lastOutputPath: trimString(state.lastOutputPath || "", 260),
      lastConfidence: Number.isFinite(Number(state.lastConfidence)) ? Number(state.lastConfidence) : 0,
      lastDuplicateStatus: trimString(state.lastDuplicateStatus || "original", 40) || "original",
      stage: normalizeStage(state.stage || fallback.stage),
      lastProgressMode: trimString(state.lastProgressMode || "progressing", 40) || "progressing",
      attempts: Number.isFinite(Number(state.attempts)) ? Number(state.attempts) : 0,
      uniqueNichesTried: Array.isArray(state.uniqueNichesTried)
        ? state.uniqueNichesTried.map((item) => trimString(item, 160)).filter(Boolean)
        : [],
      duplicateHits: Number.isFinite(Number(state.duplicateHits)) ? Number(state.duplicateHits) : 0,
      successfulOutputs: Number.isFinite(Number(state.successfulOutputs)) ? Number(state.successfulOutputs) : 0
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
      typeof decision.productTitle === "string" &&
      typeof decision.productType === "string" &&
      typeof decision.niche === "string" &&
      typeof decision.targetBuyer === "string" &&
      typeof decision.listingTitle === "string" &&
      typeof decision.shortDescription === "string" &&
      typeof decision.priceSuggestion === "string" &&
      typeof decision.price === "number" &&
      typeof decision.description === "string" &&
      Array.isArray(decision.bullets) &&
      decision.bullets.every((item) => typeof item === "string") &&
      typeof decision.publishInstructions === "string" &&
      typeof decision.fileContent === "string" &&
      typeof decision.confidence === "number" &&
      decision.confidence >= 0 &&
      decision.confidence <= 1 &&
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
    status: decision?.status === "blocked_waiting_for_human" && task ? "blocked_waiting_for_human" : "completed",
    reason: trimString(decision?.reason || "", 500) || "Invalid model output",
    task,
    productTitle: trimString(decision?.productTitle || "", 200),
    productType: trimString(decision?.productType || "", 120),
    niche: trimString(decision?.niche || "", 160),
    targetBuyer: trimString(decision?.targetBuyer || "", 200),
    listingTitle: trimString(decision?.listingTitle || "", 220),
    shortDescription: trimString(decision?.shortDescription || "", 500),
    priceSuggestion: trimString(decision?.priceSuggestion || "", 80),
    price: Math.max(0, Math.min(999, Number(decision?.price || 0))),
    description: trimString(decision?.description || "", 4000),
    bullets: Array.isArray(decision?.bullets)
      ? decision.bullets.map((item) => trimString(item, 180)).filter(Boolean).slice(0, 6)
      : [],
    publishInstructions: trimString(decision?.publishInstructions || "", 1200),
    fileContent: trimString(decision?.fileContent || "", 5000),
    confidence: Math.max(0, Math.min(1, Number(decision?.confidence || 0)))
  };
}

function isUsableCompletedDecision(decision) {
  return Boolean(
    decision &&
      decision.status === "completed" &&
      trimString(decision.action || "", 280) !== "none" &&
      trimString(decision.productTitle || "", 200) &&
      trimString(decision.listingTitle || "", 220)
  );
}

function validateDecision(decision, expectedStage) {
  const issues = [];
  const normalizedStage = normalizeStage(expectedStage);

  if (!decision || typeof decision !== "object") {
    issues.push("decision_missing");
  } else {
    if (!trimString(decision.productTitle || "", 200)) {
      issues.push("missing_product_title");
    }
    if (!trimString(decision.listingTitle || "", 220)) {
      issues.push("missing_listing_title");
    }
    if (trimString(decision.action || "", 280) === "none") {
      issues.push("action_none");
    }
    if (normalizedStage !== expectedStage) {
      issues.push("invalid_stage");
    }
    if (decision.status === "blocked_waiting_for_human" && !decision.task) {
      issues.push("blocked_without_task");
    }
    if ((normalizedStage === "listing" || normalizedStage === "publish") && !isPublishReadyListing(decision)) {
      issues.push("listing_not_publish_ready");
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    stage: normalizedStage
  };
}

function countWords(value) {
  return trimString(value || "", 8000)
    .split(/\s+/)
    .filter(Boolean).length;
}

function hasRequiredPublishSteps(value) {
  const normalized = normalizeComparisonText(value);
  return (
    normalized.includes("gumroad") &&
    normalized.includes("create new product") &&
    normalized.includes("paste title") &&
    normalized.includes("upload file") &&
    normalized.includes("set price") &&
    normalized.includes("publish")
  );
}

function isApprovalTask(task) {
  return Boolean(
    task &&
      task.title === "Approve and publish product" &&
      task.details === "Publish this listing on Gumroad" &&
      task.priority === "high"
  );
}

function isPublishReadyListing(decision) {
  const descriptionWords = countWords(decision.description);
  return Boolean(
    trimString(decision.action, 280) === "create publish-ready listing" &&
      trimString(decision.productTitle, 200) &&
      trimString(decision.listingTitle, 220) &&
      Number(decision.price) >= 5 &&
      Number(decision.price) <= 19 &&
      descriptionWords >= 150 &&
      descriptionWords <= 300 &&
      Array.isArray(decision.bullets) &&
      decision.bullets.length >= 3 &&
      decision.bullets.length <= 6 &&
      decision.bullets.every((item) => trimString(item, 180).length >= 8) &&
      trimString(decision.targetBuyer, 200).length >= 8 &&
      trimString(decision.fileContent, 5000).length >= 120 &&
      hasRequiredPublishSteps(decision.publishInstructions) &&
      isApprovalTask(decision.task)
  );
}

function collectLatestOutputs(currentAgentName) {
  if (!fs.existsSync(OUTPUTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(OUTPUTS_DIR)
    .filter((entry) => entry !== currentAgentName)
    .map((entry) => path.join(OUTPUTS_DIR, entry, "latest.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => readJson(filePath, null))
    .filter(Boolean);
}

function compareOverlap(a, b) {
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

function isSimilarToOutput(candidate, other) {
  const sameType = normalizeComparisonText(candidate.productType) === normalizeComparisonText(other.productType);
  const sameNiche = normalizeComparisonText(candidate.niche) === normalizeComparisonText(other.niche);
  const sameBuyer = normalizeComparisonText(candidate.targetBuyer) === normalizeComparisonText(other.targetBuyer);
  const titleOverlap = compareOverlap(candidate.productTitle, other.productTitle);
  return (sameType && sameNiche) || (sameNiche && sameBuyer) || titleOverlap >= 0.7;
}

function isVagueOutput(decision) {
  return (
    normalizeComparisonText(decision.productTitle).length < 8 ||
    normalizeComparisonText(decision.niche).length < 4 ||
    normalizeComparisonText(decision.targetBuyer).length < 6 ||
    normalizeComparisonText(decision.fileContent).length < 40
  );
}

function isPureBrainstorming(decision) {
  const action = normalizeComparisonText(decision.action);
  return action.includes("brainstorm") || action.includes("multiple options") || action.includes("list ideas");
}

function matchesPreviousRun(decision, agentState) {
  return (
    normalizeComparisonText(decision.productTitle) === normalizeComparisonText(agentState.lastProductTitle) &&
    normalizeComparisonText(decision.productType) === normalizeComparisonText(agentState.lastProductType) &&
    normalizeComparisonText(decision.niche) === normalizeComparisonText(agentState.lastNiche) &&
    normalizeComparisonText(decision.targetBuyer) === normalizeComparisonText(agentState.lastTargetBuyer)
  );
}

function hasProgress(decision, agentState) {
  if (!agentState.lastProductTitle) {
    return true;
  }

  const reason = normalizeComparisonText(decision.reason);
  return !matchesPreviousRun(decision, agentState) || reason.includes("pivot") || reason.includes("build") || reason.includes("continue");
}

function shouldPivot(agentState) {
  return Number(agentState.lastConfidence || 0) < 0.5 || Number(agentState.duplicateHits || 0) >= 2;
}

function determineExpectedStage(agentState) {
  const currentStage = normalizeStage(agentState.stage || "idea");
  if (!agentState.lastProductTitle || !agentState.lastListingTitle) {
    return "idea";
  }
  if (currentStage === "publish") {
    return shouldPivot(agentState) ? "idea" : "publish";
  }
  return nextStage(currentStage);
}

function stageProgressMode(agentState, expectedStage) {
  return expectedStage === "idea" && agentState.lastProductTitle ? "pivoting" : "progressing";
}

function isValidStageTransition(actualStage, expectedStage) {
  return actualStage === expectedStage;
}

function hasSubstantiveContentForStage(decision, stage) {
  const contentLength = trimString(decision.fileContent || "", 12000).length;
  if (stage === "content") {
    if (normalizeComparisonText(decision.productType).includes("prompt")) {
      const promptLines = decision.fileContent.split("\n").filter((line) => /^\s*(\d+\.|-|\*)\s+/.test(line));
      return promptLines.length >= 20;
    }
    if (normalizeComparisonText(decision.productType).includes("checklist")) {
      const checklistLines = decision.fileContent.split("\n").filter((line) => /^\s*(\d+\.|-|\*)\s+/.test(line));
      return checklistLines.length >= 15;
    }
    if (normalizeComparisonText(decision.productType).includes("guide")) {
      return contentLength >= 500;
    }
    if (normalizeComparisonText(decision.productType).includes("template")) {
      return contentLength >= 300;
    }
    return contentLength >= 400;
  }
  if (stage === "outline") {
    return contentLength >= 150;
  }
  if (stage === "listing") {
    return isPublishReadyListing(decision);
  }
  if (stage === "publish") {
    return isPublishReadyListing(decision);
  }
  return contentLength >= 80;
}

function classifyDuplicate(candidate, otherOutputs) {
  const match = otherOutputs.find((other) => isSimilarToOutput(candidate, other));
  return {
    isDuplicate: Boolean(match),
    duplicateWith: match ? match.agent || "" : ""
  };
}

function buildPrompt(agentState, messages, tasks, config, options = {}) {
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
    "If you already have a product, you must improve or expand it. Do NOT generate a new idea unless explicitly pivoting.",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "For listing or publish stage, you MUST create a publish-ready Gumroad listing and include the required approval task."
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? 'Set "action" to exactly "create publish-ready listing".'
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? 'Set "task" to exactly {"title":"Approve and publish product","details":"Publish this listing on Gumroad","priority":"high"}.'
      : "",
    "",
    "Allowed actions:",
    "- create a micro-product idea and draft listing title",
    "- create a small dataset idea and draft listing title",
    "- create a product outline",
    "- create a product description",
    "- create publish-ready listing",
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
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Description must be 150-300 words, clearly state the buyer outcome, target a specific buyer, and focus on concrete benefits."
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Publish instructions must include: Go to Gumroad, create new product, paste title + description, upload file, set price, publish."
      : "",
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
    '  "price": "number",',
    '  "description": "string",',
    '  "bullets": ["string"],',
    '  "publishInstructions": "string",',
    '  "fileContent": "string",',
    '  "confidence": 0-1',
    "}",
    "",
    `Agent: ${trimString(agentState.name, 80) || "agent"}`,
    `Strategy: ${trimString(agentState.strategy, 200) || "generate digital products"}`,
    `Current stage: ${options.currentStage || "idea"}`,
    `Required next stage: ${options.expectedStage || "idea"}`,
    `Current goal: ${options.stageGoal || getStageGoal("idea")}`,
    `Progress mode: ${options.progressMode || "progressing"}`,
    `Previous product title: ${trimString(agentState.lastProductTitle || "none", 200)}`,
    `Previous product type: ${trimString(agentState.lastProductType || "none", 120)}`,
    `Previous niche: ${trimString(agentState.lastNiche || "none", 160)}`,
    `Previous target buyer: ${trimString(agentState.lastTargetBuyer || "none", 200)}`,
    `Previous listing title: ${trimString(agentState.lastListingTitle || "none", 220)}`,
    `Previous price: ${Number(agentState.lastPrice || 0) || "none"}`,
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

function writeLog(agentName, payload) {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${agentName}-${Date.now()}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function saveOutput(agentName, now, finalDecision) {
  if (!isUsableCompletedDecision(finalDecision)) {
    return "";
  }

  const agentOutputDir = path.join(OUTPUTS_DIR, agentName);
  ensureDir(agentOutputDir);
  const fileName = `${now.replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(agentOutputDir, fileName);
  const latestPath = path.join(agentOutputDir, "latest.json");
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
    price: finalDecision.price,
    description: finalDecision.description,
    bullets: finalDecision.bullets,
    publishInstructions: finalDecision.publishInstructions,
    fileContent: finalDecision.fileContent,
    confidence: finalDecision.confidence,
    action: finalDecision.action,
    reason: finalDecision.reason
  };

  try {
    console.log(`[worker] writing output to ${outputPath}`);
    writeJson(outputPath, outputPayload);
    writeJson(latestPath, outputPayload);

    if (!fs.existsSync(outputPath) || !fs.existsSync(latestPath)) {
      throw new Error("Output file verification failed after write.");
    }

    console.log(`[worker] output write success ${outputPath}`);
    return path.relative(ROOT_DIR, outputPath);
  } catch (error) {
    console.error(`[worker] output write failed ${outputPath}`);
    console.error(`[worker] output write error=${error.message}`);
    return "";
  }
}

function persistRun(agentState, messages, tasks, finalDecision, metadata) {
  const now = new Date().toISOString();
  const profit = Number((Number(agentState.revenue || 0) - Number(agentState.cost || 0)).toFixed(2));
  const latestTask = finalDecision.task ? finalDecision.task : null;
  const outputPath = saveOutput(agentState.name, now, finalDecision);
  const hasUsableOutput = isUsableCompletedDecision(finalDecision);
  const previousNiches = Array.isArray(agentState.uniqueNichesTried) ? [...agentState.uniqueNichesTried] : [];
  const nextUniqueNiches =
    hasUsableOutput && finalDecision.niche && !previousNiches.includes(finalDecision.niche)
      ? [...previousNiches, finalDecision.niche]
      : previousNiches;

  const nextAgentState = {
    ...agentState,
    lastAction: finalDecision.action,
    lastReason: finalDecision.reason,
    lastProductTitle: hasUsableOutput ? finalDecision.productTitle : agentState.lastProductTitle || "",
    lastProductType: hasUsableOutput ? finalDecision.productType : agentState.lastProductType || "",
    lastNiche: hasUsableOutput ? finalDecision.niche : agentState.lastNiche || "",
    lastTargetBuyer: hasUsableOutput ? finalDecision.targetBuyer : agentState.lastTargetBuyer || "",
    lastListingTitle: hasUsableOutput ? finalDecision.listingTitle : agentState.lastListingTitle || "",
    lastPrice: hasUsableOutput ? Number(finalDecision.price || 0) : Number(agentState.lastPrice || 0),
    lastOutputPath: hasUsableOutput ? outputPath : agentState.lastOutputPath || "",
    lastConfidence: finalDecision.confidence || 0,
    lastDuplicateStatus: metadata.duplicateStatus || "original",
    stage: normalizeStage(metadata.stage || agentState.stage || "idea"),
    lastProgressMode: metadata.progressMode || "progressing",
    lastRunAt: now,
    status: finalDecision.status,
    latestTask,
    revenue: Number(agentState.revenue || 0),
    cost: Number(agentState.cost || 0),
    profit,
    attempts: Number(agentState.attempts || 0) + 1,
    uniqueNichesTried: nextUniqueNiches,
    duplicateHits: Number(agentState.duplicateHits || 0) + (metadata.duplicateStatus === "duplicate" ? 1 : 0),
    successfulOutputs: Number(agentState.successfulOutputs || 0) + (hasUsableOutput ? 1 : 0)
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
    attemptDetails: metadata.attemptDetails || [],
    validationResults: metadata.validationResults || [],
    retryTriggered: Boolean(metadata.retryTriggered),
    finalObject: finalDecision,
    productTitle: finalDecision.productTitle || "",
    productType: finalDecision.productType || "",
    niche: finalDecision.niche || "",
    targetBuyer: finalDecision.targetBuyer || "",
    listingTitle: finalDecision.listingTitle || "",
    price: Number(finalDecision.price || 0),
    description: finalDecision.description || "",
    bullets: finalDecision.bullets || [],
    publishInstructions: finalDecision.publishInstructions || "",
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

async function runWorker(agentName) {
  const trace = [];
  let stepReached = "start";
  let geminiResponseStatus = null;
  let rawGeminiText = "";
  let parsedObject = null;
  let duplicateStatus = "original";
  let attemptDetails = [];
  let retryTriggered = false;
  let validationResults = [];
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
    const currentStage = normalizeStage(agentState.stage || "idea");
    const expectedStage = determineExpectedStage(agentState);
    const progressMode = stageProgressMode(agentState, expectedStage);
    const latestOutputs = collectLatestOutputs(agentName);
    const latestOutputsText =
      latestOutputs
        .map((item) => `- ${item.agent}: ${item.productTitle} | ${item.productType} | ${item.niche} | ${item.targetBuyer}`)
        .join("\n") || "- none";

    stepReached = "prompt";
    trace.push("prompt");
    let prompt = buildPrompt(agentState, messages, tasks, config, {
      latestOutputsText,
      currentStage,
      expectedStage,
      stageGoal: getStageGoal(expectedStage),
      progressMode
    });
    if (!prompt || !prompt.trim()) {
      throw new Error("Generated prompt is empty.");
    }

    stepReached = "gemini";
    trace.push("gemini");
    let finalDecision = { ...FALLBACK_INVALID_MODEL_OUTPUT };

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
      const validation = validateDecision(finalDecision, expectedStage);
      validationResults.push({
        attempt: attempt + 1,
        parsed: Boolean(parsedObject),
        shapeValid: isValidDecisionShape(parsedObject),
        status: finalDecision.status,
        action: finalDecision.action,
        issues: validation.issues
      });
      attemptDetails.push({
        attempt: attempt + 1,
        rawGeminiText: trimString(rawGeminiText, 2000),
        parsedObject,
        validation
      });
      trace.push(`validate:${attempt + 1}:${validation.isValid ? "valid" : validation.issues.join(",") || "invalid"}`);

      if (!validation.isValid && attempt === 0) {
        retryTriggered = true;
        prompt = buildPrompt(agentState, messages, tasks, config, {
          latestOutputsText,
          currentStage,
          expectedStage,
          stageGoal: getStageGoal(expectedStage),
          progressMode,
          retryInstruction:
            "Your previous response was invalid. You must return complete, valid JSON with all required fields."
        });
        continue;
      }

      if (!validation.isValid) {
        finalDecision = { ...FALLBACK_INVALID_MODEL_OUTPUT };
        duplicateStatus = "original";
        break;
      }

      const progressOkay =
        finalDecision.status !== "completed" ||
        (hasProgress(finalDecision, agentState) && !isVagueOutput(finalDecision) && !isPureBrainstorming(finalDecision));
      const stageOkay =
        finalDecision.status !== "completed" || (isValidStageTransition(expectedStage, expectedStage) && hasSubstantiveContentForStage(finalDecision, expectedStage));
      const duplicateCheck =
        finalDecision.status === "completed" ? classifyDuplicate(finalDecision, latestOutputs) : { isDuplicate: false, duplicateWith: "" };

      if (finalDecision.status === "completed" && progressOkay && stageOkay && !duplicateCheck.isDuplicate) {
        duplicateStatus = "original";
        break;
      }

      if (finalDecision.status === "completed" && duplicateCheck.isDuplicate && attempt === 0) {
        duplicateStatus = "retry";
        retryTriggered = true;
        prompt = buildPrompt(agentState, messages, tasks, config, {
          latestOutputsText,
          currentStage,
          expectedStage,
          stageGoal: getStageGoal(expectedStage),
          progressMode,
          retryInstruction: `Retry once. Your last output was too similar to ${duplicateCheck.duplicateWith || "another agent"}. Choose a different niche or product type and return a distinct sellable draft.`
        });
        continue;
      }

      if (finalDecision.status === "completed" && duplicateCheck.isDuplicate) {
        duplicateStatus = "duplicate";
        finalDecision.confidence = Math.min(finalDecision.confidence || 0.35, 0.35);
        finalDecision.reason = trimString(`${finalDecision.reason} Duplicate risk remained after retry.`, 500);
      } else if (finalDecision.status === "completed" && (!progressOkay || !stageOkay)) {
        finalDecision = { ...FALLBACK_INVALID_MODEL_OUTPUT };
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
      attemptDetails,
      validationResults,
      retryTriggered,
      duplicateStatus,
      stage: expectedStage,
      progressMode,
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
        attemptDetails,
        validationResults,
        retryTriggered,
        duplicateStatus,
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
