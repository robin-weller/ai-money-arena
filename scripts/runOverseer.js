const fs = require("fs");
const path = require("path");
const { sendMessage } = require("./telegram");

const ROOT_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(ROOT_DIR, "state");
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const PUBLIC_DIR = path.join(ROOT_DIR, "public-data");

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
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
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

function countWords(value) {
  return trimString(value || "", 12000)
    .split(/\s+/)
    .filter(Boolean).length;
}

function countPromptItems(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))
        .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
        .filter(Boolean)
    )
  ).length;
}

function loadDraftContent(agent) {
  const workingDraft = trimString(agent.workingFileContent || "", 12000);
  if (workingDraft) {
    return workingDraft;
  }

  const outputPath = trimString(agent.lastOutputPath || "", 260);
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

function computeCompletionPercent(agent, draftContent, wordCount, promptCount) {
  if (Number(agent.completionPercent || 0) > 0) {
    return Number(agent.completionPercent || 0);
  }
  if (agent.isProductComplete) {
    return 100;
  }

  const productType = normalizeComparisonText(agent.lastProductType || "");
  if (productType.includes("prompt")) {
    return Math.max(0, Math.min(100, Math.round((promptCount / 25) * 100)));
  }
  if (productType.includes("guide")) {
    return Math.max(0, Math.min(100, Math.round((wordCount / 800) * 100)));
  }
  if (productType.includes("checklist")) {
    const checklistItems = String(draftContent || "")
      .split("\n")
      .filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
    return Math.max(0, Math.min(100, Math.round((checklistItems / 15) * 100)));
  }

  return Math.max(0, Math.min(100, Math.round((trimString(draftContent || "", 12000).length / 400) * 100)));
}

function summarizeAgentProgress(agent) {
  const draftContent = loadDraftContent(agent);
  const wordCount = Number(agent.workingWordCount || 0) || countWords(draftContent);
  const promptCount = Number(agent.workingPromptCount || 0) || countPromptItems(draftContent);
  const completionPercent = computeCompletionPercent(agent, draftContent, wordCount, promptCount);

  return {
    wordCount,
    promptCount,
    completionPercent
  };
}

function normalizeDisplayedAction(action) {
  const normalized = trimString(action || "", 280);
  return normalized === "retry_next_run" ? "expand_existing_product" : normalized;
}

function getAgentStates() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const filePath = path.join(AGENTS_DIR, fileName);
      const state = readJson(filePath);
      console.log(`[overseer] loaded path=${filePath}`);
      console.log(`[overseer] loaded status=${state.status || ""}`);
      console.log(`[overseer] loaded lastAction=${state.lastAction || ""}`);
      console.log(`[overseer] loaded lastRunAt=${state.lastRunAt || ""}`);
      return state;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getLatestRuns(limit) {
  if (!fs.existsSync(LOGS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(LOGS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map((fileName) => readJson(path.join(LOGS_DIR, fileName)));
}

function outputFileName(outputPath) {
  return path.basename(String(outputPath || ""));
}

function buildLeaderboard(agentStates) {
  return {
    generatedAt: new Date().toISOString(),
    agents: agentStates
      .map((agent) => {
        const revenue = Number(agent.revenue || 0);
        const cost = Number(agent.cost || 0);
        const profit = Number((revenue - cost).toFixed(2));
        const progress = summarizeAgentProgress(agent);

        return {
          name: agent.name,
          strategy: agent.strategy,
          revenue,
          cost,
          profit,
          status: agent.status,
          lastAction: normalizeDisplayedAction(agent.lastAction || ""),
          lastRunAt: agent.lastRunAt || "",
          lastProductTitle: agent.lastProductTitle || "",
          lastListingTitle: agent.lastListingTitle || "",
          lastPrice: Number(agent.lastPrice || 0),
          lastOutputPath: agent.lastOutputPath || "",
          lastOutputFile: outputFileName(agent.lastOutputPath || ""),
          assetReady: Boolean(agent.lastOutputPath) && Boolean(agent.isProductComplete),
          productComplete: Boolean(agent.isProductComplete),
          productCompletenessIssues: Array.isArray(agent.productCompletenessIssues) ? agent.productCompletenessIssues : [],
          isPublished: Boolean(agent.publishedUrl),
          publishedUrl: agent.publishedUrl || "",
          distributionAttempts: Number(agent.distributionAttempts || 0),
          lastProductType: agent.lastProductType || "",
          lastNiche: agent.lastNiche || "",
          lastConfidence: Number(agent.lastConfidence || 0),
          lastDuplicateStatus: agent.lastDuplicateStatus || "original",
          stage: agent.stage || "idea",
          lastProgressMode: agent.lastProgressMode || "progressing",
          publishReady: Boolean(agent.publishReady),
          completionPercent: progress.completionPercent,
          wordCount: progress.wordCount,
          promptCount: progress.promptCount
        };
      })
      .sort((a, b) => b.profit - a.profit)
  };
}

function buildTelegramSummary(leaderboard, openTasks) {
  const lines = [];
  lines.push("AI Money Arena Summary");
  lines.push("");

  for (const agent of leaderboard.agents) {
    const readyFlag = agent.publishReady ? "READY TO PUBLISH" : "IN PROGRESS";
    const liveFlag = agent.publishedUrl ? "LIVE" : "NOT LIVE";
    lines.push(
      `${agent.name}: ${agent.lastAction || "No action"} | product=${agent.lastProductTitle || "-"} | file=${agent.lastOutputFile || "-"} | price=$${Number(agent.lastPrice || 0).toFixed(2)} | ready=${agent.assetReady ? "yes" : "no"} | ${readyFlag} | ${liveFlag} | progress=${Number(agent.completionPercent || 0)}% | words=${Number(agent.wordCount || 0)} | prompts=${Number(agent.promptCount || 0)} | distributionAttempts=${Number(agent.distributionAttempts || 0)} | listing=${agent.lastListingTitle || "-"} | type=${agent.lastProductType || "-"} | niche=${agent.lastNiche || "-"} | stage=${agent.stage} | mode=${agent.lastProgressMode} | confidence=${agent.lastConfidence} | originality=${agent.lastDuplicateStatus} | revenue=${agent.revenue} | cost=${agent.cost} | profit=${agent.profit} | status=${agent.status}`
    );
  }

  lines.push("");
  lines.push(`Open human tasks: ${openTasks.length}`);

  for (const task of openTasks.slice(0, 10)) {
    lines.push(`- ${task.agent}: ${task.title || task.task}`);
  }

  return lines.join("\n").slice(0, 3900);
}

async function run() {
  ensureDir(PUBLIC_DIR);

  const config = readJson(path.join(STATE_DIR, "config.json"), {});
  const agentStates = getAgentStates();
  const openTasks = agentStates
    .filter((agent) => agent.latestTask)
    .map((agent) => ({
      agent: agent.name,
      title: agent.latestTask.title,
      details: agent.latestTask.details,
      priority: agent.latestTask.priority,
      status: "open",
      reason: agent.lastReason || ""
    }));
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
    tasks: openTasks
  });
  writeJson(path.join(STATE_DIR, "tasks.json"), openTasks);

  console.log("[overseer] Public data updated");
  console.log(`[overseer] Agents: ${agentStates.length}, open tasks: ${openTasks.length}`);

  try {
    const summary = buildTelegramSummary(leaderboard, openTasks);
    const result = await sendMessage(process.env.TELEGRAM_CHAT_ID, summary);
    if (result?.skipped) {
      console.log("[overseer] Telegram summary skipped");
    } else {
      console.log("[overseer] Telegram summary sent");
    }
  } catch (error) {
    console.log(`[overseer] Telegram send skipped/failed: ${error.message}`);
  }
}

run().catch((error) => {
  console.error("[overseer] Fatal error:", error);
  process.exit(1);
});
