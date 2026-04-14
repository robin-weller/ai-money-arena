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
    price: 0,
    description: "",
    bullets: [],
    redditPosts: [],
    commentReplies: [],
    suggestedCommunities: [],
    suggestedSearchQueries: [],
    burnerFriendly: false,
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
} as const;

const FALLBACK_RUNTIME_FAILURE = {
  action: "retry_next_run",
  status: "completed",
  reason: "Runtime failure, will retry next cycle",
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
  price: number;
  description: string;
  bullets: string[];
  redditPosts: string[];
  commentReplies: string[];
  suggestedCommunities: string[];
  suggestedSearchQueries: string[];
  burnerFriendly: boolean;
  publishInstructions: string;
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

function normalizeStage(stage: string): "idea" | "outline" | "content" | "listing" | "publish" {
  return ["idea", "outline", "content", "listing", "publish"].includes(stage)
    ? (stage as "idea" | "outline" | "content" | "listing" | "publish")
    : "idea";
}

function nextStage(
  currentStage: "idea" | "outline" | "content" | "listing" | "publish"
): "idea" | "outline" | "content" | "listing" | "publish" {
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

function getStageGoal(stage: "idea" | "outline" | "content" | "listing" | "publish"): string {
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
      lastPrice: Number.isFinite(Number(state.lastPrice)) ? Number(state.lastPrice) : 0,
      lastOutputPath: trimString(state.lastOutputPath || "", 260),
      lastConfidence: Number.isFinite(Number(state.lastConfidence)) ? Number(state.lastConfidence) : 0,
      lastDuplicateStatus: trimString(state.lastDuplicateStatus || "original", 40) || "original",
      stage: normalizeStage(state.stage || fallback.stage),
      lastProgressMode: trimString(state.lastProgressMode || "progressing", 40) || "progressing",
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
      typeof decision.price === "number" &&
      typeof decision.description === "string" &&
      Array.isArray(decision.bullets) &&
      decision.bullets.every((item: unknown) => typeof item === "string") &&
      Array.isArray(decision.redditPosts) &&
      decision.redditPosts.every((item: unknown) => typeof item === "string") &&
      Array.isArray(decision.commentReplies) &&
      decision.commentReplies.every((item: unknown) => typeof item === "string") &&
      Array.isArray(decision.suggestedCommunities) &&
      decision.suggestedCommunities.every((item: unknown) => typeof item === "string") &&
      Array.isArray(decision.suggestedSearchQueries) &&
      decision.suggestedSearchQueries.every((item: unknown) => typeof item === "string") &&
      typeof decision.burnerFriendly === "boolean" &&
      typeof decision.publishInstructions === "string" &&
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
    price: normalizePriceValue({
      ...decision,
      price: Number(decision?.price || 0),
      priceSuggestion: trimString(decision?.priceSuggestion || "", 80)
    } as WorkerDecision),
    description: trimString(decision?.description || "", 4000),
    bullets: Array.isArray(decision?.bullets)
      ? decision.bullets.map((item: unknown) => trimString(item, 180)).filter(Boolean).slice(0, 6)
      : [],
    redditPosts: Array.isArray(decision?.redditPosts)
      ? decision.redditPosts.map((item: unknown) => trimString(item, 500)).filter(Boolean).slice(0, 4)
      : [],
    commentReplies: Array.isArray(decision?.commentReplies)
      ? decision.commentReplies.map((item: unknown) => trimString(item, 400)).filter(Boolean).slice(0, 4)
      : [],
    suggestedCommunities: Array.isArray(decision?.suggestedCommunities)
      ? decision.suggestedCommunities.map((item: unknown) => trimString(item, 120)).filter(Boolean).slice(0, 8)
      : [],
    suggestedSearchQueries: Array.isArray(decision?.suggestedSearchQueries)
      ? decision.suggestedSearchQueries.map((item: unknown) => trimString(item, 180)).filter(Boolean).slice(0, 8)
      : [],
    burnerFriendly: Boolean(decision?.burnerFriendly),
    publishInstructions: trimString(decision?.publishInstructions || "", 1200),
    fileContent: trimString(decision?.fileContent || "", 5000),
    confidence: Math.max(0, Math.min(1, Number(decision?.confidence || 0)))
  };
}

function isUsableCompletedDecision(decision: WorkerDecision): boolean {
  return Boolean(
    decision &&
      decision.status === "completed" &&
      trimString(decision.action || "", 280) !== "none" &&
      trimString(decision.productTitle || "", 200) &&
      trimString(decision.listingTitle || "", 220)
  );
}

function validateDecision(
  decision: WorkerDecision,
  expectedStage: "idea" | "outline" | "content" | "listing" | "publish"
): { isValid: boolean; issues: string[]; stage: "idea" | "outline" | "content" | "listing" | "publish" } {
  const issues: string[] = [];
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

function countWords(value: unknown): number {
  return trimString(value || "", 8000)
    .split(/\s+/)
    .filter(Boolean).length;
}

function hasRequiredPublishSteps(value: string): boolean {
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

function isApprovalTask(task: TaskPayload | null): boolean {
  return Boolean(
    task &&
      task.title === "Approve and publish product" &&
      task.details === "Publish this listing on Gumroad" &&
      task.priority === "high"
  );
}

function isPublishReadyListing(decision: WorkerDecision): boolean {
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
      Array.isArray(decision.redditPosts) &&
      decision.redditPosts.length >= 2 &&
      decision.redditPosts.every((item) => trimString(item, 500).length >= 40) &&
      Array.isArray(decision.commentReplies) &&
      decision.commentReplies.length >= 2 &&
      decision.commentReplies.every((item) => trimString(item, 400).length >= 30) &&
      Array.isArray(decision.suggestedCommunities) &&
      decision.suggestedCommunities.length >= 2 &&
      Array.isArray(decision.suggestedSearchQueries) &&
      decision.suggestedSearchQueries.length >= 2 &&
      decision.burnerFriendly === true &&
      trimString(decision.targetBuyer, 200).length >= 8 &&
      trimString(decision.fileContent, 5000).length >= 120 &&
      hasRequiredPublishSteps(decision.publishInstructions) &&
      isApprovalTask(decision.task)
  );
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

function shouldPivot(agentState: any): boolean {
  return Number(agentState.lastConfidence || 0) < 0.5 || Number(agentState.duplicateHits || 0) >= 2;
}

function determineExpectedStage(agentState: any): "idea" | "outline" | "content" | "listing" | "publish" {
  const currentStage = normalizeStage(agentState.stage || "idea");
  if (!agentState.lastProductTitle || !agentState.lastListingTitle) {
    return "idea";
  }
  if (currentStage === "publish") {
    return shouldPivot(agentState) ? "idea" : "publish";
  }
  return nextStage(currentStage);
}

function stageProgressMode(
  agentState: any,
  expectedStage: "idea" | "outline" | "content" | "listing" | "publish"
): "progressing" | "pivoting" {
  return expectedStage === "idea" && agentState.lastProductTitle ? "pivoting" : "progressing";
}

function hasSubstantiveContentForStage(
  decision: WorkerDecision,
  stage: "idea" | "outline" | "content" | "listing" | "publish"
): boolean {
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
  options: {
    latestOutputsText?: string;
    retryInstruction?: string;
    currentStage?: string;
    expectedStage?: string;
    stageGoal?: string;
    progressMode?: string;
  } = {}
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
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Distribution output must be safe for anonymous or burner-friendly accounts."
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Include redditPosts, commentReplies, suggestedCommunities, suggestedSearchQueries, and set burnerFriendly to true."
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Use a helpful, conversational, non-promotional tone. Avoid spammy language and obvious self-promotion."
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
    '  "redditPosts": ["string"],',
    '  "commentReplies": ["string"],',
    '  "suggestedCommunities": ["string"],',
    '  "suggestedSearchQueries": ["string"],',
    '  "burnerFriendly": true | false,',
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

function slugify(value: unknown): string {
  const slug = normalizeComparisonText(value).replace(/\s+/g, "-");
  return slug || `product-${Date.now()}`;
}

function normalizePriceValue(decision: WorkerDecision): number {
  const directPrice = Number(decision?.price || 0);
  const suggestion = trimString(decision?.priceSuggestion || "", 80);
  const matched = suggestion.match(/(\d+(?:\.\d+)?)/);
  const parsedSuggestion = matched ? Number(matched[1]) : NaN;
  const candidate = directPrice > 0 ? directPrice : Number.isFinite(parsedSuggestion) ? parsedSuggestion : 9.99;
  return Math.min(19.99, Math.max(5, Number(candidate.toFixed(2))));
}

function buildFallbackPrompts(decision: WorkerDecision): string[] {
  const product = trimString(decision.productTitle || "Digital Product", 200);
  const niche = trimString(decision.niche || "your niche", 160);
  const buyer = trimString(decision.targetBuyer || "your buyer", 200);
  const prompts: string[] = [];

  for (let index = 1; index <= 24; index += 1) {
    prompts.push(`Prompt ${index}: Create a practical ${niche} asset for ${buyer} that delivers a clear result related to ${product}. Include specific constraints, examples, and next steps.`);
  }

  return prompts;
}

function extractPromptCandidates(text: string): string[] {
  const lines = trimString(text || "", 12000)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = lines
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length >= 20);

  return Array.from(new Set(candidates));
}

function buildPromptSections(prompts: string[]): Array<{ label: string; prompts: string[] }> {
  const labels = ["Research And Positioning", "Creation And Delivery", "Marketing And Optimization", "Scaling And Retention"];
  const perSection = Math.ceil(prompts.length / labels.length);
  return labels.map((label, index) => ({
    label,
    prompts: prompts.slice(index * perSection, (index + 1) * perSection)
  }));
}

function renderPromptPackMarkdown(decision: WorkerDecision, assetFileName: string): string {
  const extractedPrompts = extractPromptCandidates(decision.fileContent);
  const prompts = extractedPrompts.length >= 20 ? extractedPrompts.slice(0, 24) : buildFallbackPrompts(decision);
  const sections = buildPromptSections(prompts);
  const intro = trimString(
    decision.description ||
      `This pack helps ${decision.targetBuyer} get faster, more consistent results in ${decision.niche} with ready-to-run prompts.`,
    600
  );
  const howToUse = [
    "1. Pick the prompt category that matches your immediate goal.",
    "2. Paste the prompt into your AI tool and replace placeholders with your own context.",
    "3. Save the best outputs, refine them, and repeat with the follow-up prompts."
  ];
  const tips = [
    "Be specific about your audience, offer, and constraints before running a prompt.",
    "Reuse strong outputs as source material for the next prompt in the pack.",
    "Keep a swipe file of the best responses so you can improve them over time."
  ];

  return [
    `# ${decision.productTitle}`,
    "",
    intro,
    "",
    "## How To Use",
    ...howToUse,
    "",
    ...sections.flatMap((section) => [
      `## ${section.label}`,
      ...section.prompts.map((prompt, index) => `${index + 1}. ${prompt}`),
      ""
    ]),
    "## Final Tips",
    ...tips.map((tip) => `- ${tip}`),
    "",
    `File to upload: ${assetFileName}`
  ]
    .join("\n")
    .trim();
}

function renderGenericMarkdown(decision: WorkerDecision, assetFileName: string): string {
  const description = trimString(
    decision.description || decision.shortDescription || `A practical asset for ${decision.targetBuyer} in ${decision.niche}.`,
    4000
  );
  const bullets = Array.isArray(decision.bullets) && decision.bullets.length
    ? decision.bullets
    : [
        `Built for ${decision.targetBuyer}`,
        `Focused on a clear ${decision.niche} outcome`,
        "Ready to use immediately after download"
      ];

  return [
    `# ${decision.productTitle}`,
    "",
    description,
    "",
    "## What Is Included",
    ...bullets.map((bullet) => `- ${bullet}`),
    "",
    "## How To Use",
    `1. Open the asset and review the material for ${decision.targetBuyer}.`,
    "2. Customize any placeholders with your own business or audience context.",
    "3. Apply the asset immediately and save your preferred version.",
    "",
    "## Final Asset",
    trimString(decision.fileContent || "", 12000),
    "",
    `File to upload: ${assetFileName}`
  ]
    .join("\n")
    .trim();
}

function renderDistributionSection(decision: WorkerDecision): string {
  return [
    "## Anonymous Distribution Plan",
    `Burner-friendly: ${decision.burnerFriendly ? "yes" : "no"}`,
    "",
    "### Suggested Communities",
    ...decision.suggestedCommunities.map((item) => `- ${item}`),
    "",
    "### Suggested Search Queries",
    ...decision.suggestedSearchQueries.map((item) => `- ${item}`),
    "",
    "### Reddit Posts",
    ...decision.redditPosts.map((item, index) => `${index + 1}. ${item}`),
    "",
    "### Comment Replies",
    ...decision.commentReplies.map((item, index) => `${index + 1}. ${item}`)
  ]
    .join("\n")
    .trim();
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\-\s+/gm, "* ")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function buildPublishInstructions(decision: WorkerDecision, uploadFileName: string, price: number): string {
  const lines = [
    "1. Go to Gumroad.",
    "2. Create a new product.",
    `3. Use the title: ${decision.listingTitle || decision.productTitle}.`,
    `4. Set the price to $${price.toFixed(2)}.`,
    `5. Upload the file: ${uploadFileName}.`,
    "6. Paste the sales description and publish."
  ];

  return lines.join("\n");
}

function renderPublishAssets(decision: WorkerDecision): {
  slug: string;
  markdownFileName: string;
  textFileName: string;
  markdown: string;
  text: string;
  price: number;
  publishInstructions: string;
} {
  const price = normalizePriceValue(decision);
  const slug = slugify(decision.productTitle || decision.listingTitle || "product");
  const markdownFileName = `${slug}.md`;
  const textFileName = `${slug}.txt`;
  const markdown = normalizeComparisonText(decision.productType).includes("prompt")
    ? renderPromptPackMarkdown(decision, markdownFileName)
    : renderGenericMarkdown(decision, markdownFileName);
  const distributionSection = renderDistributionSection(decision);
  const fullMarkdown = `${markdown}\n\n${distributionSection}`.trim();
  const text = markdownToText(fullMarkdown);

  return {
    slug,
    markdownFileName,
    textFileName,
    markdown: fullMarkdown,
    text,
    price,
    publishInstructions: buildPublishInstructions(decision, markdownFileName, price)
  };
}

function writeLog(agentName: string, payload: unknown): void {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${agentName}-${Date.now()}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function saveOutput(agentName: string, now: string, finalDecision: WorkerDecision): string {
  if (!isUsableCompletedDecision(finalDecision)) {
    return "";
  }

  const agentOutputDir = path.join(OUTPUTS_DIR, agentName);
  ensureDir(agentOutputDir);
  const fileName = `${now.replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(agentOutputDir, fileName);
  const latestPath = path.join(agentOutputDir, "latest.json");
  const renderedAssets = renderPublishAssets(finalDecision);
  finalDecision.price = renderedAssets.price;
  finalDecision.priceSuggestion = String(renderedAssets.price.toFixed(2));
  finalDecision.publishInstructions = renderedAssets.publishInstructions;
  finalDecision.fileContent = renderedAssets.markdown;
  const markdownPath = path.join(agentOutputDir, renderedAssets.markdownFileName);
  const textPath = path.join(agentOutputDir, renderedAssets.textFileName);
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
    redditPosts: finalDecision.redditPosts,
    commentReplies: finalDecision.commentReplies,
    suggestedCommunities: finalDecision.suggestedCommunities,
    suggestedSearchQueries: finalDecision.suggestedSearchQueries,
    burnerFriendly: finalDecision.burnerFriendly,
    publishInstructions: finalDecision.publishInstructions,
    fileContent: finalDecision.fileContent,
    markdownFile: path.relative(ROOT_DIR, markdownPath),
    textFile: path.relative(ROOT_DIR, textPath),
    confidence: finalDecision.confidence,
    action: finalDecision.action,
    reason: finalDecision.reason
  };

  try {
    console.log(`[worker] writing output to ${outputPath}`);
    writeJson(outputPath, outputPayload);
    writeJson(latestPath, outputPayload);
    fs.writeFileSync(markdownPath, `${renderedAssets.markdown}\n`, "utf8");
    fs.writeFileSync(textPath, `${renderedAssets.text}\n`, "utf8");

    if (!fs.existsSync(outputPath) || !fs.existsSync(latestPath) || !fs.existsSync(markdownPath) || !fs.existsSync(textPath)) {
      throw new Error("Output file verification failed after write.");
    }

    console.log(`[worker] output write success ${markdownPath}`);
    return path.relative(ROOT_DIR, markdownPath);
  } catch (error: any) {
    console.error(`[worker] output write failed ${outputPath}`);
    console.error(`[worker] output write error=${error.message}`);
    return "";
  }
}

function persistRun(agentState: any, messages: any[], tasks: any[], finalDecision: WorkerDecision, metadata: any) {
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
    redditPosts: finalDecision.redditPosts || [],
    commentReplies: finalDecision.commentReplies || [],
    suggestedCommunities: finalDecision.suggestedCommunities || [],
    suggestedSearchQueries: finalDecision.suggestedSearchQueries || [],
    burnerFriendly: Boolean(finalDecision.burnerFriendly),
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

export async function runWorker(agentName: string): Promise<WorkerDecision> {
  const trace: string[] = [];
  let stepReached = "start";
  let geminiResponseStatus: number | null = null;
  let rawGeminiText = "";
  let parsedObject: any = null;
  let duplicateStatus = "original";
  let attemptDetails: any[] = [];
  let retryTriggered = false;
  let validationResults: any[] = [];
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
      const stageOkay = finalDecision.status !== "completed" || hasSubstantiveContentForStage(finalDecision, expectedStage);
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
        attemptDetails,
        validationResults,
        retryTriggered,
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
