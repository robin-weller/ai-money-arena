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
    redditPosts: [],
    commentReplies: [],
    suggestedCommunities: [],
    suggestedSearchQueries: [],
    linksShared: [],
    burnerFriendly: false,
    publishInstructions: "",
    fileContent: "",
    confidence: 0
  };
}

const FALLBACK_INVALID_MODEL_OUTPUT = {
  action: "expand_existing_product",
  status: "completed",
  reason: "Model failed to expand the existing product, continue the same draft next cycle",
  task: null,
  ...defaultCompletedFields()
};

const FALLBACK_RUNTIME_FAILURE = {
  action: "expand_existing_product",
  status: "completed",
  reason: "Runtime failure while expanding the existing product, continue the same draft next cycle",
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
    isPublished: false,
    publishedUrl: "",
    lastConfidence: 0,
    lastDuplicateStatus: "original",
    stage: "idea",
    lastProgressMode: "progressing",
    attempts: 0,
    distributionAttempts: 0,
    linksShared: [],
    uniqueNichesTried: [],
    duplicateHits: 0,
    successfulOutputs: 0,
    isProductComplete: false,
    productCompletenessIssues: [],
    publishReady: false,
    workingFileContent: "",
    workingWordCount: 0,
    workingPromptCount: 0,
    completionPercent: 0
  };
}

function normalizeStage(stage) {
  const normalized = trimString(stage || "", 40).toLowerCase();
  if (normalized === "outline") {
    return "content";
  }
  return ["idea", "content", "listing", "publish"].includes(normalized) ? normalized : "idea";
}

function nextStage(currentStage) {
  if (currentStage === "idea") {
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
  if (stage === "content") {
    return "Generate a finished, sellable product with complete content and no placeholders or outlines.";
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
      isPublished: Boolean(state.isPublished) || Boolean(trimString(state.publishedUrl || "", 500)),
      publishedUrl: trimString(state.publishedUrl || "", 500),
      lastConfidence: Number.isFinite(Number(state.lastConfidence)) ? Number(state.lastConfidence) : 0,
      lastDuplicateStatus: trimString(state.lastDuplicateStatus || "original", 40) || "original",
      stage: normalizeStage(state.stage || fallback.stage),
      lastProgressMode: trimString(state.lastProgressMode || "progressing", 40) || "progressing",
      attempts: Number.isFinite(Number(state.attempts)) ? Number(state.attempts) : 0,
      distributionAttempts: Number.isFinite(Number(state.distributionAttempts)) ? Number(state.distributionAttempts) : 0,
      linksShared: Array.isArray(state.linksShared)
        ? state.linksShared.map((item) => trimString(item, 500)).filter(Boolean)
        : [],
      uniqueNichesTried: Array.isArray(state.uniqueNichesTried)
        ? state.uniqueNichesTried.map((item) => trimString(item, 160)).filter(Boolean)
        : [],
      duplicateHits: Number.isFinite(Number(state.duplicateHits)) ? Number(state.duplicateHits) : 0,
      successfulOutputs: Number.isFinite(Number(state.successfulOutputs)) ? Number(state.successfulOutputs) : 0,
      isProductComplete: Boolean(state.isProductComplete),
      productCompletenessIssues: Array.isArray(state.productCompletenessIssues)
        ? state.productCompletenessIssues.map((item) => trimString(item, 120)).filter(Boolean)
        : [],
      publishReady: Boolean(state.publishReady),
      workingFileContent: trimString(state.workingFileContent || "", 12000),
      workingWordCount: Number.isFinite(Number(state.workingWordCount)) ? Number(state.workingWordCount) : 0,
      workingPromptCount: Number.isFinite(Number(state.workingPromptCount)) ? Number(state.workingPromptCount) : 0,
      completionPercent: Number.isFinite(Number(state.completionPercent)) ? Number(state.completionPercent) : 0
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
      Array.isArray(decision.redditPosts) &&
      decision.redditPosts.every((item) => typeof item === "string") &&
      Array.isArray(decision.commentReplies) &&
      decision.commentReplies.every((item) => typeof item === "string") &&
      Array.isArray(decision.suggestedCommunities) &&
      decision.suggestedCommunities.every((item) => typeof item === "string") &&
      Array.isArray(decision.suggestedSearchQueries) &&
      decision.suggestedSearchQueries.every((item) => typeof item === "string") &&
      Array.isArray(decision.linksShared) &&
      decision.linksShared.every((item) => typeof item === "string") &&
      typeof decision.burnerFriendly === "boolean" &&
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
    price: normalizePriceValue({
      price: Number(decision?.price || 0),
      priceSuggestion: trimString(decision?.priceSuggestion || "", 80)
    }),
    description: trimString(decision?.description || "", 4000),
    bullets: Array.isArray(decision?.bullets)
      ? decision.bullets.map((item) => trimString(item, 180)).filter(Boolean).slice(0, 6)
      : [],
    redditPosts: Array.isArray(decision?.redditPosts)
      ? decision.redditPosts.map((item) => trimString(item, 500)).filter(Boolean).slice(0, 4)
      : [],
    commentReplies: Array.isArray(decision?.commentReplies)
      ? decision.commentReplies.map((item) => trimString(item, 400)).filter(Boolean).slice(0, 4)
      : [],
    suggestedCommunities: Array.isArray(decision?.suggestedCommunities)
      ? decision.suggestedCommunities.map((item) => trimString(item, 120)).filter(Boolean).slice(0, 8)
      : [],
    suggestedSearchQueries: Array.isArray(decision?.suggestedSearchQueries)
      ? decision.suggestedSearchQueries.map((item) => trimString(item, 180)).filter(Boolean).slice(0, 8)
      : [],
    linksShared: Array.isArray(decision?.linksShared)
      ? decision.linksShared.map((item) => trimString(item, 500)).filter(Boolean).slice(0, 8)
      : [],
    burnerFriendly: Boolean(decision?.burnerFriendly),
    publishInstructions: trimString(decision?.publishInstructions || "", 1200),
    fileContent: trimString(decision?.fileContent || "", 12000),
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

function extractUrlsFromText(value) {
  return String(value || "").match(/https?:\/\/[^\s)]+/gi) || [];
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => trimString(item, 500)).filter(Boolean)));
}

function distributionIncludesPublishedUrl(decision, publishedUrl) {
  const normalizedUrl = trimString(publishedUrl || "", 500);
  if (!normalizedUrl) {
    return true;
  }

  const distributionText = [
    ...(Array.isArray(decision?.redditPosts) ? decision.redditPosts : []),
    ...(Array.isArray(decision?.commentReplies) ? decision.commentReplies : []),
    ...(Array.isArray(decision?.linksShared) ? decision.linksShared : [])
  ]
    .map((item) => trimString(item, 1200))
    .join("\n");

  return distributionText.includes(normalizedUrl);
}

function validateDecision(decision, expectedStage, agentState) {
  const issues = [];
  const normalizedStage = normalizeStage(expectedStage);
  const publishedUrl = trimString(agentState?.publishedUrl || "", 500);
  const completeness =
    normalizedStage === "content" || normalizedStage === "listing" || normalizedStage === "publish"
      ? validateProductCompleteness(decision)
      : { isComplete: true, issues: [] };

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
    if (normalizedStage === "content" && hasExistingProduct(agentState) && trimString(decision.action || "", 280) !== "expand_existing_product") {
      issues.push("must_expand_existing_product");
    }
    if (normalizedStage !== expectedStage) {
      issues.push("invalid_stage");
    }
    if (decision.status === "blocked_waiting_for_human" && !decision.task) {
      issues.push("blocked_without_task");
    }
    if (!completeness.isComplete) {
      issues.push(...completeness.issues);
    }
    if ((normalizedStage === "listing" || normalizedStage === "publish") && !isPublishReadyListing(decision, publishedUrl)) {
      issues.push("listing_not_publish_ready");
    }
    if (publishedUrl && !distributionIncludesPublishedUrl(decision, publishedUrl)) {
      issues.push("missing_published_url_in_distribution");
    }
  }

  return {
    isValid: issues.length === 0,
    issues: uniqueStrings(issues),
    stage: normalizedStage,
    completeness
  };
}

function countWords(value) {
  return trimString(value || "", 8000)
    .split(/\s+/)
    .filter(Boolean).length;
}

function countListItems(value) {
  return String(value || "")
    .split("\n")
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function hasExistingProduct(agentState) {
  return Boolean(
    trimString(agentState?.lastProductTitle || "", 200) &&
      trimString(agentState?.lastListingTitle || "", 220)
  );
}

function readExistingDraft(agentState) {
  const storedDraft = trimString(agentState?.workingFileContent || "", 12000);
  if (storedDraft) {
    return storedDraft;
  }

  const outputPath = trimString(agentState?.lastOutputPath || "", 260);
  if (!outputPath) {
    return "";
  }

  const absolutePath = path.join(ROOT_DIR, outputPath);
  try {
    return fs.existsSync(absolutePath) ? trimString(fs.readFileSync(absolutePath, "utf8"), 12000) : "";
  } catch (_error) {
    return "";
  }
}

function buildFallbackDecision(agentState, reason, confidence = 0) {
  return {
    action: "expand_existing_product",
    status: "completed",
    reason: trimString(reason, 500),
    task: null,
    productTitle: trimString(agentState?.lastProductTitle || "", 200),
    productType: trimString(agentState?.lastProductType || "", 120),
    niche: trimString(agentState?.lastNiche || "", 160),
    targetBuyer: trimString(agentState?.lastTargetBuyer || "", 200),
    listingTitle: trimString(agentState?.lastListingTitle || "", 220),
    shortDescription: "",
    priceSuggestion: "",
    price: Number(agentState?.lastPrice || 0),
    description: "",
    bullets: [],
    redditPosts: [],
    commentReplies: [],
    suggestedCommunities: [],
    suggestedSearchQueries: [],
    linksShared: Array.isArray(agentState?.linksShared) ? agentState.linksShared : [],
    burnerFriendly: false,
    publishInstructions: "",
    fileContent: readExistingDraft(agentState),
    confidence: Math.max(0, Math.min(1, confidence))
  };
}

function containsOutlineMarker(value) {
  return /\boutline\b/i.test(String(value || ""));
}

function containsPlaceholderBrackets(value) {
  return /\[[^[\]\n]{1,120}\]/.test(String(value || ""));
}

function extractStructuredSections(value) {
  const lines = String(value || "").split("\n");
  const sections = [];
  let currentSection = null;

  function pushCurrentSection() {
    if (!currentSection) {
      return;
    }
    const content = currentSection.lines.join("\n").trim();
    sections.push({
      heading: currentSection.heading,
      content,
      wordCount: countWords(content)
    });
    currentSection = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+/.test(line) || /^(section|chapter|part)\s+\d+[:.-]/i.test(line)) {
      pushCurrentSection();
      currentSection = {
        heading: line.replace(/^#{1,6}\s+/, "").trim(),
        lines: []
      };
      continue;
    }

    if (!currentSection) {
      currentSection = {
        heading: "Introduction",
        lines: []
      };
    }

    currentSection.lines.push(rawLine);
  }

  pushCurrentSection();

  return sections.filter((section) => section.heading || section.content);
}

function hasSectionWithoutContent(sections, minimumWords = 20) {
  return sections.some((section) => section.heading && section.wordCount < minimumWords);
}

function isBulletOnlySection(sectionContent) {
  const lines = String(sectionContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return Boolean(lines.length) && lines.every((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line));
}

function validatePromptPackContent(fileContent) {
  const prompts = extractPromptCandidates(fileContent);
  const sections = extractStructuredSections(fileContent);
  const issues = [];

  if (prompts.length < 25) {
    issues.push("prompt_pack_needs_25_prompts");
  }
  if (prompts.some((prompt) => countWords(prompt) < 6)) {
    issues.push("prompt_pack_has_thin_prompts");
  }
  if (hasSectionWithoutContent(sections, 20)) {
    issues.push("prompt_pack_has_empty_section");
  }

  return {
    isComplete: issues.length === 0,
    issues,
    promptCount: prompts.length
  };
}

function validateMiniGuideContent(fileContent) {
  const sections = extractStructuredSections(fileContent);
  const realSections = sections.filter((section) => section.heading && section.heading !== "Introduction");
  const issues = [];
  const totalWords = countWords(fileContent);

  if (totalWords < 800) {
    issues.push("mini_guide_needs_800_words");
  }
  if (realSections.length < 4) {
    issues.push("mini_guide_needs_multiple_sections");
  }
  if (realSections.some((section) => section.wordCount < 100)) {
    issues.push("mini_guide_has_short_section");
  }
  if (realSections.some((section) => isBulletOnlySection(section.content))) {
    issues.push("mini_guide_has_bullet_only_section");
  }

  return {
    isComplete: issues.length === 0,
    issues,
    sectionCount: realSections.length,
    totalWords
  };
}

function validateChecklistContent(fileContent) {
  const checklistLines = String(fileContent || "")
    .split("\n")
    .filter((line) => /^\s*(\d+\.|-|\*)\s+/.test(line));
  const issues = [];

  if (checklistLines.length < 15) {
    issues.push("checklist_needs_15_items");
  }

  return {
    isComplete: issues.length === 0,
    issues,
    itemCount: checklistLines.length
  };
}

function validateTemplateContent(fileContent) {
  const issues = [];

  if (trimString(fileContent || "", 12000).length < 300) {
    issues.push("template_needs_more_content");
  }

  return {
    isComplete: issues.length === 0,
    issues
  };
}

function validateGenericProductContent(fileContent) {
  const issues = [];
  const sections = extractStructuredSections(fileContent);

  if (trimString(fileContent || "", 12000).length < 400) {
    issues.push("content_too_short");
  }
  if (hasSectionWithoutContent(sections, 20)) {
    issues.push("section_without_content");
  }

  return {
    isComplete: issues.length === 0,
    issues
  };
}

function validateProductCompleteness(decision) {
  const fileContent = trimString(decision?.fileContent || "", 12000);
  const productType = normalizeComparisonText(decision?.productType || "");
  const issues = [];

  if (!fileContent) {
    issues.push("missing_file_content");
  }
  if (containsOutlineMarker(fileContent)) {
    issues.push("contains_outline");
  }
  if (containsPlaceholderBrackets(fileContent)) {
    issues.push("contains_placeholder_brackets");
  }

  let typeValidation = { isComplete: true, issues: [] };
  if (productType.includes("prompt")) {
    typeValidation = validatePromptPackContent(fileContent);
  } else if (productType.includes("guide")) {
    typeValidation = validateMiniGuideContent(fileContent);
  } else if (productType.includes("checklist")) {
    typeValidation = validateChecklistContent(fileContent);
  } else if (productType.includes("template")) {
    typeValidation = validateTemplateContent(fileContent);
  } else {
    typeValidation = validateGenericProductContent(fileContent);
  }

  issues.push(...typeValidation.issues);

  return {
    isComplete: issues.length === 0,
    issues: uniqueStrings(issues),
    details: typeValidation
  };
}

function summarizeProductMetrics(decision) {
  const productType = normalizeComparisonText(decision?.productType || "");
  const fileContent = trimString(decision?.fileContent || "", 12000);

  return {
    wordCount: countWords(fileContent),
    promptCount: productType.includes("prompt") ? extractPromptCandidates(fileContent).length : 0,
    checklistItemCount: productType.includes("checklist") ? countListItems(fileContent) : 0
  };
}

function calculateCompletionPercent(decision, completeness = validateProductCompleteness(decision)) {
  if (completeness.isComplete) {
    return 100;
  }

  const productType = normalizeComparisonText(decision?.productType || "");
  const metrics = summarizeProductMetrics(decision);
  const details = completeness.details || {};

  if (productType.includes("prompt")) {
    return clampPercent((metrics.promptCount / 25) * 100);
  }
  if (productType.includes("guide")) {
    const wordProgress = Math.min(1, metrics.wordCount / 800);
    const sectionProgress = Math.min(1, Number(details.sectionCount || 0) / 4);
    const qualityPenalty =
      details.issues && details.issues.length
        ? Math.max(0.4, 1 - details.issues.length * 0.15)
        : 1;
    return clampPercent(((wordProgress + sectionProgress) / 2) * 100 * qualityPenalty);
  }
  if (productType.includes("checklist")) {
    return clampPercent((Number(details.itemCount || metrics.checklistItemCount || 0) / 15) * 100);
  }
  if (productType.includes("template")) {
    return clampPercent((trimString(decision?.fileContent || "", 12000).length / 300) * 100);
  }

  return clampPercent((trimString(decision?.fileContent || "", 12000).length / 400) * 100);
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

function isPublishReadyListing(decision, publishedUrl = "") {
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
      Array.isArray(decision.linksShared) &&
      decision.burnerFriendly === true &&
      trimString(decision.targetBuyer, 200).length >= 8 &&
      trimString(decision.fileContent, 5000).length >= 120 &&
      hasRequiredPublishSteps(decision.publishInstructions) &&
      distributionIncludesPublishedUrl(decision, publishedUrl) &&
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
  const previousDraftLength = trimString(agentState.workingFileContent || "", 12000).length;
  const nextDraftLength = trimString(decision.fileContent || "", 12000).length;
  const previousCompletionPercent = Number(agentState.completionPercent || 0);
  const nextCompletionPercent = calculateCompletionPercent(decision);

  return (
    !matchesPreviousRun(decision, agentState) ||
    nextDraftLength > previousDraftLength ||
    nextCompletionPercent > previousCompletionPercent ||
    reason.includes("pivot") ||
    reason.includes("build") ||
    reason.includes("continue") ||
    reason.includes("expand") ||
    normalizeComparisonText(decision.action).includes("expand existing product")
  );
}

function shouldPivot(agentState) {
  return Number(agentState.lastConfidence || 0) < 0.5 || Number(agentState.duplicateHits || 0) >= 2;
}

function determineExpectedStage(agentState) {
  const currentStage = normalizeStage(agentState.stage || "idea");
  if (!hasExistingProduct(agentState)) {
    return "idea";
  }
  if (!agentState.isProductComplete) {
    return "content";
  }
  if (currentStage === "publish") {
    return shouldPivot(agentState) ? "idea" : "publish";
  }
  return nextStage(currentStage);
}

function stageProgressMode(agentState, expectedStage) {
  if (expectedStage === "content" && hasExistingProduct(agentState)) {
    return "expanding";
  }
  return expectedStage === "idea" && agentState.lastProductTitle ? "pivoting" : "progressing";
}

function isValidStageTransition(actualStage, expectedStage) {
  return actualStage === expectedStage;
}

function hasSubstantiveContentForStage(decision, stage) {
  const contentLength = trimString(decision.fileContent || "", 12000).length;
  if (stage === "content") {
    return validateProductCompleteness(decision).isComplete;
  }
  if (stage === "listing") {
    return validateProductCompleteness(decision).isComplete && isPublishReadyListing(decision);
  }
  if (stage === "publish") {
    return validateProductCompleteness(decision).isComplete && isPublishReadyListing(decision);
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
  const mustExpandExistingProduct = Boolean(options.mustExpandExistingProduct);
  const existingDraft = trimString(options.existingDraft || "", 2400);
  const existingMetrics = options.existingMetrics || {};
  const missingIssues = Array.isArray(options.completenessIssues) && options.completenessIssues.length
    ? options.completenessIssues.join(", ")
    : "none";

  const prompt = [
    "You are an autonomous agent whose goal is to generate money.",
    "Choose exactly ONE concrete monetisation action for this run.",
    "You must either build on your previous output with a concrete improvement or pivot with a clear reason.",
    "If you already have a product, you must improve or expand it. Do NOT generate a new idea unless explicitly pivoting.",
    "You must complete the existing product. Do not retry or restart. Expand it until it is fully usable.",
    mustExpandExistingProduct ? "You already have a product draft. Continue building the same product and preserve the strong parts." : "",
    mustExpandExistingProduct ? "If stage = content, you MUST expand the existing product instead of retrying or proposing a new idea." : "",
    mustExpandExistingProduct ? "If the product is incomplete, regenerate ONLY the missing or weak sections. Do not discard existing work." : "",
    mustExpandExistingProduct ? "Return the full updated product in fileContent, including the existing strong material plus the repaired sections." : "",
    "A product is only valid if it is fully usable without human editing.",
    "Do not produce outlines, skeletons, placeholders, or partial drafts.",
    'If productType is "mini guide", fileContent must be a finished guide with at least 800 words, full written sections, and no bullet-only sections.',
    'If productType is "prompt pack", fileContent must contain at least 25 directly usable prompts with no bracket placeholders like [topic] or [audience].',
    "If fileContent would contain the word outline, placeholder brackets, or empty sections, regenerate it before responding.",
    mustExpandExistingProduct && options.expectedStage === "content"
      ? 'Set "action" to exactly "expand_existing_product".'
      : "",
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
      ? "If a published URL already exists, include that exact URL in the distribution output and linksShared."
      : "",
    options.expectedStage === "listing" || options.expectedStage === "publish"
      ? "Use a helpful, conversational, non-promotional tone. Avoid spammy language and obvious self-promotion."
      : "",
    "",
    "Allowed actions:",
    "- create a micro-product idea and draft listing title",
    "- create a small dataset idea and draft listing title",
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
    '  "linksShared": ["string"],',
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
    `Published status: ${agentState.isPublished ? "live" : "not live"}`,
    `Published URL: ${trimString(agentState.publishedUrl || "none", 500)}`,
    `Distribution attempts so far: ${Number(agentState.distributionAttempts || 0)}`,
    `Links already shared: ${Array.isArray(agentState.linksShared) && agentState.linksShared.length ? agentState.linksShared.join(", ") : "none"}`,
    `Current draft completion: ${Number(existingMetrics.completionPercent || agentState.completionPercent || 0)}%`,
    `Current draft word count: ${Number(existingMetrics.wordCount || agentState.workingWordCount || 0)}`,
    `Current draft prompt count: ${Number(existingMetrics.promptCount || agentState.workingPromptCount || 0)}`,
    `Current draft issues: ${missingIssues}`,
    mustExpandExistingProduct ? `Current draft content:\n${existingDraft || "- none yet"}` : "",
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

function slugify(value) {
  const slug = normalizeComparisonText(value).replace(/\s+/g, "-");
  return slug || `product-${Date.now()}`;
}

function normalizePriceValue(decision) {
  const directPrice = Number(decision?.price || 0);
  const suggestion = trimString(decision?.priceSuggestion || "", 80);
  const matched = suggestion.match(/(\d+(?:\.\d+)?)/);
  const parsedSuggestion = matched ? Number(matched[1]) : NaN;
  const candidate = directPrice > 0 ? directPrice : Number.isFinite(parsedSuggestion) ? parsedSuggestion : 9.99;
  return Math.min(19.99, Math.max(5, Number(candidate.toFixed(2))));
}

function extractPromptCandidates(text) {
  const lines = trimString(text || "", 12000)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = lines
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length >= 20);

  return Array.from(new Set(candidates));
}

function buildPromptSections(prompts) {
  const labels = ["Research And Positioning", "Creation And Delivery", "Marketing And Optimization", "Scaling And Retention"];
  const perSection = Math.ceil(prompts.length / labels.length);
  return labels.map((label, index) => ({
    label,
    prompts: prompts.slice(index * perSection, (index + 1) * perSection)
  }));
}

function renderPromptPackMarkdown(decision, assetFileName) {
  const extractedPrompts = extractPromptCandidates(decision.fileContent);
  const prompts = extractedPrompts.slice(0, 30);
  const sections = buildPromptSections(prompts);
  const intro = trimString(
    decision.description ||
      `This pack helps ${decision.targetBuyer} get faster, more consistent results in ${decision.niche} with ready-to-run prompts.`,
    600
  );
  const howToUse = [
    "1. Pick the prompt category that matches your immediate goal.",
    "2. Paste the prompt into your AI tool exactly as written and run it immediately.",
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

function renderGenericMarkdown(decision, assetFileName) {
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
    "2. Use the material as written to complete the task or implement the workflow.",
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

function renderDistributionSection(decision) {
  return [
    "## Anonymous Distribution Plan",
    `Burner-friendly: ${decision.burnerFriendly ? "yes" : "no"}`,
    `Published URL: ${trimString(decision.publishedUrl || "", 500) || "not live yet"}`,
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
    ...decision.commentReplies.map((item, index) => `${index + 1}. ${item}`),
    "",
    "### Links Shared",
    ...(Array.isArray(decision.linksShared) && decision.linksShared.length
      ? decision.linksShared.map((item) => `- ${item}`)
      : ["- none yet"])
  ]
    .join("\n")
    .trim();
}

function markdownToText(markdown) {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\-\s+/gm, "* ")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function buildPublishInstructions(decision, uploadFileName, price) {
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

function renderPublishAssets(decision) {
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

function writeLog(agentName, payload) {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${agentName}-${Date.now()}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function saveOutput(agentName, now, finalDecision) {
  const completeness = validateProductCompleteness(finalDecision);
  if (!isUsableCompletedDecision(finalDecision) || !completeness.isComplete) {
    return "";
  }

  const agentOutputDir = path.join(OUTPUTS_DIR, agentName);
  ensureDir(agentOutputDir);
  const fileName = `${now.replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(agentOutputDir, fileName);
  const latestPath = path.join(agentOutputDir, "latest.json");
  const renderedAssets = renderPublishAssets(finalDecision);
  const renderedMetrics = summarizeProductMetrics({ productType: finalDecision.productType, fileContent: renderedAssets.markdown });
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
    linksShared: finalDecision.linksShared,
    publishedUrl: finalDecision.publishedUrl || "",
     burnerFriendly: finalDecision.burnerFriendly,
     publishInstructions: finalDecision.publishInstructions,
     fileContent: finalDecision.fileContent,
     productComplete: true,
     completenessIssues: [],
     wordCount: Number(renderedMetrics.wordCount || 0),
     promptCount: Number(renderedMetrics.promptCount || 0),
     completionPercent: 100,
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
  const publishedUrl = trimString(agentState.publishedUrl || "", 500);
  const productCompleteness = validateProductCompleteness(finalDecision);
  const productMetrics = summarizeProductMetrics(finalDecision);
  const completionPercent = calculateCompletionPercent(finalDecision, productCompleteness);
  const hasUsableOutput = isUsableCompletedDecision(finalDecision);
  const isCompleteProduct = hasUsableOutput && productCompleteness.isComplete;
  const distributionUrls = uniqueStrings([
    ...extractUrlsFromText(finalDecision.publishInstructions || ""),
    ...extractUrlsFromText((finalDecision.redditPosts || []).join("\n")),
    ...extractUrlsFromText((finalDecision.commentReplies || []).join("\n")),
    ...(Array.isArray(finalDecision.linksShared) ? finalDecision.linksShared : []),
    publishedUrl
  ]);
  finalDecision.linksShared = distributionUrls;
  finalDecision.publishedUrl = publishedUrl;
  const outputPath = saveOutput(agentState.name, now, finalDecision);
  const hasDistributionOutput = Boolean(
    Array.isArray(finalDecision.redditPosts) && finalDecision.redditPosts.length &&
      Array.isArray(finalDecision.commentReplies) && finalDecision.commentReplies.length
  );
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
    isPublished: Boolean(publishedUrl),
    publishedUrl,
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
    distributionAttempts:
      Number(agentState.distributionAttempts || 0) +
      (hasUsableOutput && hasDistributionOutput ? 1 : 0),
    linksShared: uniqueStrings([...(Array.isArray(agentState.linksShared) ? agentState.linksShared : []), ...distributionUrls]),
    uniqueNichesTried: nextUniqueNiches,
    duplicateHits: Number(agentState.duplicateHits || 0) + (metadata.duplicateStatus === "duplicate" ? 1 : 0),
    successfulOutputs: Number(agentState.successfulOutputs || 0) + (outputPath ? 1 : 0),
    isProductComplete: hasUsableOutput ? isCompleteProduct : Boolean(agentState.isProductComplete),
    productCompletenessIssues:
      hasUsableOutput
        ? productCompleteness.issues
        : Array.isArray(agentState.productCompletenessIssues)
          ? agentState.productCompletenessIssues
          : [],
    workingFileContent: hasUsableOutput
      ? trimString(finalDecision.fileContent || "", 12000)
      : trimString(agentState.workingFileContent || "", 12000),
    workingWordCount: hasUsableOutput ? Number(productMetrics.wordCount || 0) : Number(agentState.workingWordCount || 0),
    workingPromptCount: hasUsableOutput ? Number(productMetrics.promptCount || 0) : Number(agentState.workingPromptCount || 0),
    completionPercent: hasUsableOutput ? completionPercent : Number(agentState.completionPercent || 0),
    publishReady:
      hasUsableOutput
        ? Boolean(
            isCompleteProduct &&
              metadata.stage === "publish" &&
              isPublishReadyListing(finalDecision, publishedUrl)
          )
        : Boolean(agentState.publishReady)
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
    linksShared: finalDecision.linksShared || [],
    publishedUrl,
    isPublished: Boolean(publishedUrl),
    productComplete: isCompleteProduct,
    productCompletenessIssues: productCompleteness.issues,
    wordCount: Number(productMetrics.wordCount || 0),
    promptCount: Number(productMetrics.promptCount || 0),
    completionPercent,
    distributionAttempts: Number(nextAgentState.distributionAttempts || 0),
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
    const mustExpandExistingProduct = Boolean(expectedStage === "content" && hasExistingProduct(agentState));
    const existingDraft = readExistingDraft(agentState);
    const existingDraftDecision = mustExpandExistingProduct
      ? {
          productType: agentState.lastProductType,
          fileContent: existingDraft
        }
      : null;
    const existingDraftCompleteness = existingDraftDecision
      ? validateProductCompleteness(existingDraftDecision)
      : { isComplete: false, issues: [] };
    const existingDraftMetrics = existingDraftDecision
      ? {
          ...summarizeProductMetrics(existingDraftDecision),
          completionPercent: calculateCompletionPercent(existingDraftDecision, existingDraftCompleteness)
        }
      : {
          wordCount: Number(agentState.workingWordCount || 0),
          promptCount: Number(agentState.workingPromptCount || 0),
          completionPercent: Number(agentState.completionPercent || 0)
        };
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
      progressMode,
      mustExpandExistingProduct,
      existingDraft,
      completenessIssues:
        mustExpandExistingProduct && existingDraftCompleteness.issues.length
          ? existingDraftCompleteness.issues
          : agentState.productCompletenessIssues,
      existingMetrics: existingDraftMetrics
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
      const validation = validateDecision(finalDecision, expectedStage, agentState);
      validationResults.push({
        attempt: attempt + 1,
        parsed: Boolean(parsedObject),
        shapeValid: isValidDecisionShape(parsedObject),
        status: finalDecision.status,
        action: finalDecision.action,
        issues: validation.issues,
        completenessIssues: validation.completeness?.issues || []
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
          mustExpandExistingProduct,
          existingDraft,
          completenessIssues: validation.completeness?.issues?.length
            ? validation.completeness.issues
            : agentState.productCompletenessIssues,
          existingMetrics: existingDraftMetrics,
          retryInstruction:
            mustExpandExistingProduct
              ? "Your previous response was invalid. Keep the same product, preserve usable material, and expand only the missing sections until the draft is complete."
              : "Your previous response was invalid. You must return complete, valid JSON with all required fields."
        });
        continue;
      }

      if (!validation.isValid) {
        finalDecision = hasExistingProduct(agentState)
          ? buildFallbackDecision(agentState, "The model returned invalid output while expanding the existing product. Keep the same draft and continue filling missing sections.")
          : { ...FALLBACK_INVALID_MODEL_OUTPUT };
        duplicateStatus = "original";
        break;
      }

      const progressOkay =
        finalDecision.status !== "completed" ||
        (hasProgress(finalDecision, agentState) && !isVagueOutput(finalDecision) && !isPureBrainstorming(finalDecision));
      const stageOkay =
        finalDecision.status !== "completed" || (isValidStageTransition(expectedStage, expectedStage) && hasSubstantiveContentForStage(finalDecision, expectedStage));
      const duplicateCheck =
        finalDecision.status === "completed" && !mustExpandExistingProduct
          ? classifyDuplicate(finalDecision, latestOutputs)
          : { isDuplicate: false, duplicateWith: "" };

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
          mustExpandExistingProduct,
          existingDraft,
          completenessIssues: validation.completeness?.issues || agentState.productCompletenessIssues,
          existingMetrics: existingDraftMetrics,
          retryInstruction: mustExpandExistingProduct
            ? "Your last response stayed too close to the current draft without materially improving it. Keep the same product and add the missing sections or missing prompts so completion percentage increases."
            : `Your last output was too similar to ${duplicateCheck.duplicateWith || "another agent"}. Choose a different niche or product type and return a distinct sellable draft.`
        });
        continue;
      }

      if (finalDecision.status === "completed" && duplicateCheck.isDuplicate) {
        duplicateStatus = "duplicate";
        finalDecision.confidence = Math.min(finalDecision.confidence || 0.35, 0.35);
        finalDecision.reason = trimString(`${finalDecision.reason} Duplicate risk remained after retry.`, 500);
      } else if (finalDecision.status === "completed" && (!progressOkay || !stageOkay)) {
        finalDecision = hasExistingProduct(agentState)
          ? buildFallbackDecision(agentState, "The agent did not add enough new substance. Keep the same product and continue expanding the missing content.")
          : { ...FALLBACK_INVALID_MODEL_OUTPUT };
        duplicateStatus = "original";
      }
      break;
    }

    stepReached = "save";
    trace.push("save");
    const shouldAdvanceStage = Boolean(
      finalDecision.status === "completed" &&
        trimString(finalDecision.productTitle || "", 200) &&
        trimString(finalDecision.listingTitle || "", 220) &&
        (expectedStage === "idea" || validateProductCompleteness(finalDecision).isComplete)
    );
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
      stage: shouldAdvanceStage ? expectedStage : currentStage,
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
    if (hasExistingProduct(agentState)) {
      Object.assign(
        fallbackDecision,
        buildFallbackDecision(agentState, "Runtime failure while expanding the existing product. Keep the same draft and continue next cycle.")
      );
    }
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
  extractJson,
  normalizeStage,
  validateProductCompleteness,
  summarizeProductMetrics,
  calculateCompletionPercent,
  hasSubstantiveContentForStage,
  isPublishReadyListing
};
