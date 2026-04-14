const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..", "..");
const ARTIFACTS_DIR = path.join(ROOT_DIR, "worker-artifacts");
const TARGET_STATE_DIR = path.join(ROOT_DIR, "state");
const TARGET_LOGS_DIR = path.join(ROOT_DIR, "logs");

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

function getArtifactAgentName(artifactDir) {
  return artifactDir.replace(/^worker-state-/, "");
}

function mergeAgentFiles() {
  ensureDir(path.join(TARGET_STATE_DIR, "agents"));
  const merged = new Map();

  for (const artifactDir of fs.readdirSync(ARTIFACTS_DIR)) {
    const agentName = getArtifactAgentName(artifactDir);
    const agentsDir = path.join(ARTIFACTS_DIR, artifactDir, "state", "agents");
    if (!fs.existsSync(agentsDir)) {
      continue;
    }

    const fileName = `${agentName}.json`;
    const source = path.join(agentsDir, fileName);
    if (!fs.existsSync(source)) {
      continue;
    }

    const sourceState = readJson(source, null);
    const existing = merged.get(agentName);
    const sourceRunAt = String(sourceState?.lastRunAt || "");
    const existingRunAt = String(existing?.lastRunAt || "");
    if (!existing || sourceRunAt >= existingRunAt) {
      merged.set(agentName, sourceState);
    }
  }

  for (const [agentName, state] of merged.entries()) {
    writeJson(path.join(TARGET_STATE_DIR, "agents", `${agentName}.json`), state);
  }
}

function mergeMessages() {
  const baseline = readJson(path.join(ROOT_DIR, "state", "messages.json"), []);
  const merged = [...baseline];
  const seen = new Set(baseline.map((item) => JSON.stringify(item)));

  for (const artifactDir of fs.readdirSync(ARTIFACTS_DIR)) {
    const agentName = getArtifactAgentName(artifactDir);
    const filePath = path.join(ARTIFACTS_DIR, artifactDir, "state", "messages.json");
    const items = readJson(filePath, []).filter((item) => item.agent === agentName);

    for (const item of items) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  merged.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  writeJson(path.join(ROOT_DIR, "state", "messages.json"), merged);
}

function rebuildTasksFromAgents() {
  const tasks = fs
    .readdirSync(path.join(TARGET_STATE_DIR, "agents"))
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readJson(path.join(TARGET_STATE_DIR, "agents", fileName), {}))
    .filter((agent) => agent.status === "blocked_waiting_for_human" && agent.latestTask)
    .map((agent) => ({
      id: `${agent.name}-${String(agent.lastRunAt || Date.now()).replace(/[^0-9]/g, "").slice(0, 20)}`,
      createdAt: agent.lastRunAt || new Date().toISOString(),
      agent: agent.name,
      title: agent.latestTask.title,
      details: agent.latestTask.details,
      priority: agent.latestTask.priority,
      reason: agent.lastReason || "",
      status: "open"
    }));

  writeJson(path.join(ROOT_DIR, "state", "tasks.json"), tasks);
}

function mergeLogs() {
  ensureDir(TARGET_LOGS_DIR);

  for (const artifactDir of fs.readdirSync(ARTIFACTS_DIR)) {
    const logsDir = path.join(ARTIFACTS_DIR, artifactDir, "logs");
    if (!fs.existsSync(logsDir)) {
      continue;
    }

    for (const fileName of fs.readdirSync(logsDir)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }

      const source = path.join(logsDir, fileName);
      const target = path.join(TARGET_LOGS_DIR, fileName);
      fs.copyFileSync(source, target);
    }
  }
}

function run() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    throw new Error("worker-artifacts directory not found.");
  }

  mergeAgentFiles();
  mergeMessages();
  rebuildTasksFromAgents();
  mergeLogs();

  console.log("[merge-worker-artifacts] Worker outputs merged");
}

run();
