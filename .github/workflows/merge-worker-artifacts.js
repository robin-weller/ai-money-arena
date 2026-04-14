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

function mergeArrayFile(relativePath) {
  const merged = [];
  const seen = new Set();

  for (const artifactDir of fs.readdirSync(ARTIFACTS_DIR)) {
    const filePath = path.join(ARTIFACTS_DIR, artifactDir, relativePath);
    const items = readJson(filePath, []);

    for (const item of items) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  merged.sort((a, b) => String(a.timestamp || a.createdAt || "").localeCompare(String(b.timestamp || b.createdAt || "")));
  writeJson(path.join(ROOT_DIR, relativePath), merged);
}

function mergeAgentFiles() {
  ensureDir(path.join(TARGET_STATE_DIR, "agents"));

  for (const artifactDir of fs.readdirSync(ARTIFACTS_DIR)) {
    const agentsDir = path.join(ARTIFACTS_DIR, artifactDir, "state", "agents");
    if (!fs.existsSync(agentsDir)) {
      continue;
    }

    for (const fileName of fs.readdirSync(agentsDir)) {
      const source = path.join(agentsDir, fileName);
      const target = path.join(TARGET_STATE_DIR, "agents", fileName);
      fs.copyFileSync(source, target);
    }
  }
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
  mergeArrayFile(path.join("state", "messages.json"));
  mergeArrayFile(path.join("state", "tasks.json"));
  mergeLogs();

  console.log("[merge-worker-artifacts] Worker outputs merged");
}

run();
