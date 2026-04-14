(function () {
  const REFRESH_INTERVAL_MS = 60000;
  const BASE = window.location.pathname.split('/')[1] ? `/${window.location.pathname.split('/')[1]}` : '';

  function buildDataUrl(fileName) {
    return `${BASE}/public-data/${fileName}`;
  }

  async function fetchJson(fileName) {
    const url = buildDataUrl(fileName);
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return response.json();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTimestamp(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function setUpdatedText(id, ts) {
    const el = document.getElementById(id);
    if (el) el.textContent = `Updated ${formatTimestamp(ts)}`;
  }

  const STAGE_LABELS = {
    idea: 'Idea',
    building: '🔨 Building',
    ready_to_ship: '📦 Ready to Ship',
    ready_to_market: '📣 Ready to Market',
    ready_to_distribute: '🚀 Ready to Distribute',
    live: '✅ Live',
  };
  const STAGES = ['building', 'ready_to_ship', 'ready_to_market', 'ready_to_distribute', 'live', 'idea'];

  async function loadPipeline() {
    const data = await fetchJson('pipeline.json');
    setUpdatedText('pipeline-updated', data.generatedAt);

    const body = document.getElementById('pipeline-body');
    if (!body) return;

    const rows = STAGES.map(stage => {
      const products = (data.byStage || {})[stage] || [];
      const label = STAGE_LABELS[stage] || stage;
      const productList = products.map(p => escapeHtml(p.title)).join(', ') || '—';
      return `<tr><td>${escapeHtml(label)}</td><td>${products.length}</td><td class="subtle">${productList}</td></tr>`;
    }).join('');

    body.innerHTML = rows || '<tr><td colspan="3" class="empty">No pipeline data yet.</td></tr>';

    const summary = document.getElementById('pipeline-summary');
    if (summary) {
      summary.innerHTML = `
        <p>Total products: <strong>${data.totalProducts || 0}</strong></p>
        <p>Live: <strong>${((data.byStage || {}).live || []).length}</strong></p>
        <p>Total revenue: <strong>$${Number(data.totalRevenue || 0).toFixed(2)}</strong></p>
      `;
    }
  }

  async function loadProducts() {
    const data = await fetchJson('products.json');
    setUpdatedText('products-updated', data.generatedAt);

    const body = document.getElementById('products-body');
    if (!body) return;

    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No products yet.</td></tr>';
      return;
    }

    body.innerHTML = products.slice().reverse().map(p => {
      const statusClass = escapeHtml((p.status || '').replace(/_/g, '-'));
      return `<tr>
        <td>${escapeHtml(p.title || p.id)}</td>
        <td><span class="status ${statusClass}">${escapeHtml(STAGE_LABELS[p.status] || p.status)}</span></td>
        <td style="text-align:right">${p.price ? '$' + Number(p.price).toFixed(2) : '—'}</td>
        <td style="text-align:right">${p.revenue ? '$' + Number(p.revenue).toFixed(2) : '$0.00'}</td>
      </tr>`;
    }).join('');
  }

  async function loadTasks() {
    const data = await fetchJson('tasks.json');
    setUpdatedText('tasks-updated', data.generatedAt);

    const body = document.getElementById('tasks-body');
    if (!body) return;

    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) {
      body.innerHTML = '<tr><td colspan="3" class="empty">No active tasks.</td></tr>';
      return;
    }

    body.innerHTML = tasks.map(t => {
      const priority = (t.priority || 'medium').toLowerCase();
      return `<tr>
        <td>${escapeHtml(t.agent)}</td>
        <td>${escapeHtml(t.title || t.task || 'Untitled')}</td>
        <td><span class="priority ${escapeHtml(priority)}">${escapeHtml(priority)}</span></td>
      </tr>`;
    }).join('');
  }

  function startAutoRefresh(loader) {
    loader().catch(console.error);
    setInterval(() => loader().catch(console.error), REFRESH_INTERVAL_MS);
  }

  window.AIProductivityFactory = {
    startPipelinePage() { startAutoRefresh(loadPipeline); },
    startProductsPage() { startAutoRefresh(loadProducts); },
    startTasksPage() { startAutoRefresh(loadTasks); },
  };
})();
