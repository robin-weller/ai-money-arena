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

  function formatMoney(value) {
    return Number(value || 0).toFixed(5);
  }

  const THEME_META = {
    themeA: { label: 'Clean Minimal', bg: '#E5E7EB', color: '#1F2937' },
    themeB: { label: 'Bold Focus',    bg: '#22C55E', color: '#0F172A' },
    themeC: { label: 'Warm Calm',     bg: '#FFE8D6', color: '#344E41' },
  };

  function renderThemeBadge(themeId) {
    if (!themeId) return '<span style="color:#999">—</span>';
    const m = THEME_META[themeId];
    if (!m) return escapeHtml(themeId);
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75em;font-weight:600;background:${m.bg};color:${m.color}">${escapeHtml(m.label)}</span>`;
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
    design_ready: '🎨 Design Ready',
    qa_pending: '🔍 QA Pending',
    publish_ready: '✅ Publish Ready',
    live: '✅ Live',
  };
  const STAGES = ['building', 'ready_to_ship', 'ready_to_market', 'ready_to_distribute', 'design_ready', 'qa_pending', 'publish_ready', 'live', 'idea'];

  async function loadPipeline() {
    const [data, dash] = await Promise.all([
      fetchJson('pipeline.json'),
      fetchJson('dashboard.json').catch(() => ({})),
    ]);
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
      const rev = Number(dash.totalRevenue || 0);
      const cost = Number(dash.totalAiCost || 0);
      const profit = Number(dash.totalProfit || 0);
      summary.innerHTML = `
        <p>Total products: <strong>${dash.totalProducts || data.totalProducts || 0}</strong></p>
        <p>Live: <strong>${dash.liveProducts || ((data.byStage || {}).live || []).length}</strong></p>
        <p>Revenue: <strong>$${rev.toFixed(2)}</strong></p>
        <p>AI Cost: <strong>$${formatMoney(cost)}</strong></p>
        <p>Profit: <strong>$${formatMoney(profit)}</strong></p>
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
      body.innerHTML = '<tr><td colspan="8" class="empty">No products yet.</td></tr>';
      return;
    }

    body.innerHTML = products.slice().reverse().map(p => {
      const statusClass = escapeHtml((p.status || '').replace(/_/g, '-'));
      const titleCell = p.publishedUrl
        ? `<a href="${escapeHtml(p.publishedUrl)}" target="_blank" rel="noopener">${escapeHtml(p.title || p.id)}</a>${p.marketplace ? `<br><small style="color:#6B7280">${escapeHtml(p.marketplace)}</small>` : ''}`
        : escapeHtml(p.title || p.id);
      let qaBadge;
      if (p.needsHumanReview) {
        qaBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75em;font-weight:600;background:#FEE2E2;color:#991B1B">👤 Review</span>';
      } else if (p.qaStatus === 'passed') {
        qaBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75em;font-weight:600;background:#D1FAE5;color:#065F46">✓ Passed</span>';
      } else if (p.qaStatus === 'failed') {
        const reason = escapeHtml(p.qaFailureReason || p.qaFailureStage || 'failed');
        qaBadge = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75em;font-weight:600;background:#FEF3C7;color:#92400E" title="${reason}">⚠️ ${escapeHtml(p.qaFailureStage || 'failed')}</span>`;
      } else {
        qaBadge = '<span style="color:#999">—</span>';
      }
      return `<tr>
        <td>${titleCell}</td>
        <td><span class="status ${statusClass}">${escapeHtml(STAGE_LABELS[p.status] || p.status)}</span></td>
        <td>${renderThemeBadge(p.themeId)}</td>
        <td>${qaBadge}</td>
        <td style="text-align:right">$${formatMoney(p.aiCostTotal)}</td>
        <td style="text-align:right">${p.aiCalls || 0}</td>
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
