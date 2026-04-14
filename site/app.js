(function () {
  const REFRESH_INTERVAL_MS = 45000;
  const BASE = window.location.pathname.split("/")[1] ? `/${window.location.pathname.split("/")[1]}` : "";

  function buildDataUrl(fileName) {
    return `${BASE}/public-data/${fileName}`;
  }

  async function fetchJson(fileName) {
    const url = buildDataUrl(fileName);
    console.log("Fetching:", url);
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    return response.json();
  }

  function formatTimestamp(value) {
    if (!value) {
      return "Unknown";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setUpdatedText(elementId, generatedAt) {
    const target = document.getElementById(elementId);
    if (target) {
      target.textContent = `Updated ${formatTimestamp(generatedAt)}`;
    }
  }

  async function loadLeaderboard() {
    const data = await fetchJson("leaderboard.json");
    const body = document.getElementById("leaderboard-body");
    setUpdatedText("leaderboard-updated", data.generatedAt);

    if (!body) {
      return;
    }

    const agents = Array.isArray(data.agents) ? data.agents : [];
    if (!agents.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No leaderboard data yet.</td></tr>';
      return;
    }

    body.innerHTML = agents
      .map((agent) => {
        const product = agent.lastProductTitle || agent.lastAction || "No product yet";
        const statusClass = escapeHtml(agent.status || "idle");
        return `
          <tr>
            <td>${escapeHtml(agent.name)}</td>
            <td>${escapeHtml(product)}</td>
            <td class="profit">$${escapeHtml(Number(agent.profit || 0).toFixed(2))}</td>
            <td><span class="status ${statusClass}">${escapeHtml(agent.status || "idle")}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadRuns() {
    const data = await fetchJson("latest-runs.json");
    const list = document.getElementById("runs-list");
    setUpdatedText("runs-updated", data.generatedAt);

    if (!list) {
      return;
    }

    const runs = Array.isArray(data.runs) ? data.runs : [];
    if (!runs.length) {
      list.innerHTML = '<article class="card empty">No runs available yet.</article>';
      return;
    }

    list.innerHTML = runs
      .slice()
      .reverse()
      .map((run) => {
        const final = run.finalObject || {};
        const productTitle = final.productTitle || run.productTitle || run.action || "Untitled output";
        const niche = final.niche || run.niche || "Niche pending";
        const stage = run.stage || final.stage || "Unknown";
        const confidence =
          final.confidence !== undefined && final.confidence !== null
            ? Number(final.confidence).toFixed(2)
            : run.confidence !== undefined && run.confidence !== null
              ? Number(run.confidence).toFixed(2)
              : "n/a";

        return `
          <article class="card">
            <div>
              <p class="eyebrow">${escapeHtml(run.agent || "agent")}</p>
              <h3 class="card-title">${escapeHtml(productTitle)}</h3>
            </div>
            <div class="meta">
              <span class="pill">${escapeHtml(niche)}</span>
              <span class="pill">${escapeHtml(stage)}</span>
              <span class="pill confidence">confidence ${escapeHtml(confidence)}</span>
            </div>
            <p>${escapeHtml((final.shortDescription || run.reason || "").slice(0, 220) || "No description available.")}</p>
            <p class="subtle">${escapeHtml(formatTimestamp(run.timestamp || run.generatedAt))}</p>
          </article>
        `;
      })
      .join("");
  }

  async function loadTasks() {
    const data = await fetchJson("tasks.json");
    const body = document.getElementById("tasks-body");
    setUpdatedText("tasks-updated", data.generatedAt);

    if (!body) {
      return;
    }

    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) {
      body.innerHTML = '<tr><td colspan="3" class="empty">No waiting tasks.</td></tr>';
      return;
    }

    body.innerHTML = tasks
      .map((task) => {
        const priority = (task.priority || "low").toLowerCase();
        return `
          <tr>
            <td>${escapeHtml(task.agent)}</td>
            <td>${escapeHtml(task.title || task.task || "Untitled task")}</td>
            <td><span class="priority ${escapeHtml(priority)}">${escapeHtml(priority)}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  function startAutoRefresh(loader) {
    loader().catch(handleError);
    window.setInterval(() => {
      loader().catch(handleError);
    }, REFRESH_INTERVAL_MS);
  }

  function handleError(error) {
    console.error(error);
  }

  window.AIMoneyArena = {
    startLeaderboardPage() {
      startAutoRefresh(loadLeaderboard);
    },
    startRunsPage() {
      startAutoRefresh(loadRuns);
    },
    startTasksPage() {
      startAutoRefresh(loadTasks);
    }
  };
})();
