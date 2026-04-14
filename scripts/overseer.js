'use strict';
const fs = require('fs');
const path = require('path');
const { sendMessage } = require('./telegram.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const MANUAL_PUBLISH_PATH = path.join(__dirname, '../state/manual-publish.json');
const PUBLIC_DATA_DIR = path.join(__dirname, '../public-data');

const STAGES = ['idea', 'building', 'ready_to_ship', 'ready_to_market', 'ready_to_distribute', 'design_ready', 'qa_pending', 'publish_ready', 'live'];
const STAGE_LABELS = {
  idea: 'Idea',
  building: 'Building',
  ready_to_ship: 'Ready to Ship',
  ready_to_market: 'Ready to Market',
  ready_to_distribute: 'Ready to Distribute',
  design_ready: 'Design Ready',
  qa_pending: 'QA Pending',
  publish_ready: 'Publish Ready',
  live: 'Live',
};

function formatMoney(value) {
  return Number(value || 0).toFixed(5);
}

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

/**
 * Read manual-publish.json and move matching publish_ready products to live.
 * Removes processed entries from the file.
 */
function processManualPublishes(products) {
  if (!fs.existsSync(MANUAL_PUBLISH_PATH)) return false;

  let manualPublish;
  try {
    manualPublish = JSON.parse(fs.readFileSync(MANUAL_PUBLISH_PATH, 'utf8'));
  } catch {
    console.log('[overseer] Could not parse manual-publish.json, skipping');
    return false;
  }

  const publishes = Array.isArray(manualPublish.publishes) ? manualPublish.publishes : [];
  if (!publishes.length) return false;

  const remaining = [];
  let processed = 0;

  for (const entry of publishes) {
    const { productId, marketplace, publishedUrl, listingId } = entry;

    if (!productId || !publishedUrl || !marketplace) {
      console.log(`[overseer] Skipping invalid publish entry (missing productId, marketplace, or publishedUrl)`);
      remaining.push(entry);
      continue;
    }

    const idx = products.findIndex(p => p.id === productId);
    if (idx === -1) {
      console.log(`[overseer] Publish entry skipped: product not found (${productId})`);
      remaining.push(entry);
      continue;
    }

    if (products[idx].status !== 'publish_ready') {
      console.log(`[overseer] Publish entry skipped: ${productId} is not publish_ready (status: ${products[idx].status})`);
      remaining.push(entry);
      continue;
    }

    products[idx].isPublished  = true;
    products[idx].status       = 'live';
    products[idx].marketplace  = marketplace;
    products[idx].publishedUrl = publishedUrl;
    products[idx].listingId    = listingId || '';
    products[idx].publishedAt  = new Date().toISOString();
    console.log(`[overseer] ✓ Marked live: "${products[idx].title}" on ${marketplace}`);
    processed++;
  }

  // Persist remaining (unprocessed) entries back to file
  manualPublish.publishes = remaining;
  fs.writeFileSync(MANUAL_PUBLISH_PATH, JSON.stringify(manualPublish, null, 2));

  if (processed > 0) {
    saveProducts(products);
    console.log(`[overseer] Processed ${processed} manual publish(es)`);
  }

  return processed > 0;
}

function buildPipelineData(products) {
  const byStage = {};
  for (const stage of STAGES) {
    byStage[stage] = products.filter(p => p.status === stage).map(p => ({
      id: p.id,
      title: p.title || p.productType,
      productType: p.productType,
      price: p.price || 0,
      revenue: p.revenue || 0,
      elementCount: p.elementCount || 0,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    }));
  }
  return byStage;
}

function buildTelegramSummary(products, totalAiCost) {
  const byStage = buildPipelineData(products);
  const totalRevenue = products.reduce((sum, p) => sum + (p.revenue || 0), 0);
  const liveCount = (byStage.live || []).length;

  const lines = ['🏭 AI Productivity Factory\n'];

  if (byStage.building.length) {
    lines.push('🔨 Building:');
    byStage.building.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.ready_to_ship.length) {
    lines.push('\n📦 Ready to Ship:');
    byStage.ready_to_ship.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.ready_to_market.length) {
    lines.push('\n📣 Ready to Market:');
    byStage.ready_to_market.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.ready_to_distribute.length) {
    lines.push('\n🚀 Ready to Distribute:');
    byStage.ready_to_distribute.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.design_ready.length) {
    lines.push('\n🎨 Design Ready:');
    byStage.design_ready.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.qa_pending.length) {
    lines.push('\n🔍 QA Pending:');
    byStage.qa_pending.forEach(p => lines.push(`  • ${p.title}`));
  }

  if (byStage.publish_ready.length) {
    lines.push('\n✅ Publish Ready:');
    byStage.publish_ready.forEach(p => lines.push(`  • ${p.title}`));
  }

  // QA failures (products routed back from QA)
  const qaFailed = products.filter(p => p.qaStatus === 'failed' && p.status !== 'qa_pending');
  if (qaFailed.length) {
    lines.push('\n⚠️ QA Failed (re-queued):');
    qaFailed.forEach(p => lines.push(`  • ${p.title} → ${p.qaFailureStage || '?'} (${p.qaFailureReason || '?'})`));
  }

  const liveProducts = products.filter(p => p.status === 'live');
  if (liveProducts.length) {
    lines.push('\n🟢 Live:');
    liveProducts.forEach(p => {
      const marketplace = p.marketplace ? ` · ${p.marketplace}` : '';
      const revenue     = ` · revenue=$${Number(p.revenue || 0).toFixed(2)}`;
      const cost        = ` · ai=$${formatMoney(p.aiCostTotal)}`;
      lines.push(`  • ${p.title}${marketplace}${revenue}${cost}`);
    });
  }

  lines.push(`\n📊 Summary:`);
  lines.push(`  Total products: ${products.length}`);
  lines.push(`  Publish Ready: ${(byStage.publish_ready || []).length}`);
  lines.push(`  Live: ${liveCount}`);
  lines.push(`  Revenue: $${totalRevenue.toFixed(2)}`);
  lines.push(`  AI cost: $${formatMoney(totalAiCost)}`);
  lines.push(`  Profit: $${formatMoney(totalRevenue - totalAiCost)}`);

  return lines.join('\n');
}

async function run() {
  console.log('[overseer] Starting...');
  const products = loadProducts();
  console.log(`[overseer] Loaded ${products.length} products`);

  // Process any manual publish handoffs before building dashboard data
  processManualPublishes(products);

  const byStage = buildPipelineData(products);
  const totalRevenue = products.reduce((sum, p) => sum + (p.revenue || 0), 0);
  const totalAiCost = products.reduce((sum, p) => sum + (p.aiCostTotal || 0), 0);
  const totalProfit = totalRevenue - totalAiCost;

  // Write public-data/dashboard.json
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'dashboard.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalProducts: products.length,
      liveProducts: (byStage.live || []).length,
      publishReady: (byStage.publish_ready || []).length,
      uploadReady: (byStage.publish_ready || []).length,
      qaFailed: products.filter(p => p.qaStatus === 'failed').length,
      totalRevenue,
      totalAiCost,
      totalProfit,
    }, null, 2)
  );

  // Write public-data/pipeline.json
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'pipeline.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalProducts: products.length,
      totalRevenue,
      totalAiCost,
      totalProfit,
      byStage,
    }, null, 2)
  );

  // Write public-data/products.json (lightweight — dashboard source of truth)
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'products.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      products: products.map(p => ({
        id: p.id,
        title: p.title || p.productType,
        status: p.status,
        price: p.price || 0,
        revenue: p.revenue || 0,
        isPublished: p.isPublished || false,
        marketplace: p.marketplace || null,
        publishedUrl: p.publishedUrl || null,
        publishedAt: p.publishedAt || null,
        listingId: p.listingId || null,
        aiCostTotal: p.aiCostTotal || 0,
        aiCalls: p.aiCalls || 0,
        themeId: p.themeId || null,
        designReady: p.designReady || false,
        designOutputPaths: p.designOutputPaths || null,
        qaStatus: p.qaStatus || null,
        qaFailureStage: p.qaFailureStage || null,
        qaFailureReason: p.qaFailureReason || null,
        qaRetryCount: p.qaRetryCount || 0,
        needsHumanReview: p.needsHumanReview || false,
      })),
    }, null, 2)
  );

  // Write backward-compat leaderboard.json for old site
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'leaderboard.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      agents: [
        {
          name: 'Product Agent',
          lastProductTitle: byStage.building[0]?.title || byStage.ready_to_ship[0]?.title || 'Idle',
          profit: totalRevenue,
          status: byStage.building.length ? 'building' : 'idle',
        },
        {
          name: 'Sales Agent',
          lastProductTitle: byStage.ready_to_market[0]?.title || 'Idle',
          profit: 0,
          status: byStage.ready_to_ship.length ? 'active' : 'idle',
        },
        {
          name: 'Marketing Agent',
          lastProductTitle: byStage.ready_to_distribute[0]?.title || 'Idle',
          profit: 0,
          status: byStage.ready_to_market.length ? 'active' : 'idle',
        },
        {
          name: 'Design Agent',
          lastProductTitle: byStage.design_ready[0]?.title || 'Idle',
          profit: 0,
          status: byStage.ready_to_distribute.length ? 'active' : 'idle',
        },
      ],
    }, null, 2)
  );

  // Stage counts for tasks view
  const stageCounts = STAGES.map(s => ({ stage: s, label: STAGE_LABELS[s], count: byStage[s].length }));
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'tasks.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      tasks: stageCounts.filter(s => s.count > 0).map(s => ({
        agent: 'Pipeline',
        title: `${s.count} product(s) in ${s.label}`,
        priority: s.stage === 'building' ? 'high' : 'medium',
      })),
    }, null, 2)
  );

  // Send Telegram summary
  const summary = buildTelegramSummary(products, totalAiCost);
  console.log('[overseer] Telegram summary:');
  console.log(summary);
  try {
    await sendMessage(null, summary);
    console.log('[overseer] Telegram sent');
  } catch (err) {
    console.log(`[overseer] Telegram skipped: ${err.message}`);
  }

  console.log('[overseer] Done.');
}

run().catch(err => { console.error('[overseer] Fatal:', err.message); process.exit(1); });
