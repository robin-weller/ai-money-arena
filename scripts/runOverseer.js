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

        return {
          name: agent.name,
          strategy: agent.strategy,
          revenue,
          cost,
          profit,
          status: agent.status,
          lastAction: agent.lastAction || "",
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
          publishReady: Boolean(agent.publishReady)
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
      `${agent.name}: ${agent.lastAction || "No action"} | product=${agent.lastProductTitle || "-"} | file=${agent.lastOutputFile || "-"} | price=$${Number(agent.lastPrice || 0).toFixed(2)} | ready=${agent.assetReady ? "yes" : "no"} | ${readyFlag} | ${liveFlag} | distributionAttempts=${Number(agent.distributionAttempts || 0)} | listing=${agent.lastListingTitle || "-"} | type=${agent.lastProductType || "-"} | niche=${agent.lastNiche || "-"} | stage=${agent.stage} | mode=${agent.lastProgressMode} | confidence=${agent.lastConfidence} | originality=${agent.lastDuplicateStatus} | revenue=${agent.revenue} | cost=${agent.cost} | profit=${agent.profit} | status=${agent.status}`
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
