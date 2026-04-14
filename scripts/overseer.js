'use strict';
const fs = require('fs');
const path = require('path');
const { sendMessage } = require('./telegram.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const PUBLIC_DATA_DIR = path.join(__dirname, '../public-data');

const STAGES = ['idea', 'building', 'ready_to_ship', 'ready_to_market', 'ready_to_distribute', 'live'];
const STAGE_LABELS = {
  idea: 'Idea',
  building: 'Building',
  ready_to_ship: 'Ready to Ship',
  ready_to_market: 'Ready to Market',
  ready_to_distribute: 'Ready to Distribute',
  live: 'Live',
};

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
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

function buildTelegramSummary(products) {
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

  if (byStage.live.length) {
    lines.push('\n✅ Live:');
    byStage.live.forEach(p => lines.push(`  • ${p.title} | $${Number(p.price || 0).toFixed(2)} | revenue=$${Number(p.revenue || 0).toFixed(2)}`));
  }

  lines.push(`\n📊 Summary:`);
  lines.push(`  Total products: ${products.length}`);
  lines.push(`  Live: ${liveCount}`);
  lines.push(`  Total revenue: $${totalRevenue.toFixed(2)}`);

  return lines.join('\n');
}

async function run() {
  console.log('[overseer] Starting...');
  const products = loadProducts();
  console.log(`[overseer] Loaded ${products.length} products`);

  const byStage = buildPipelineData(products);
  const totalRevenue = products.reduce((sum, p) => sum + (p.revenue || 0), 0);

  // Write public-data/pipeline.json
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'pipeline.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalProducts: products.length,
      totalRevenue,
      byStage,
    }, null, 2)
  );

  // Write public-data/products.json
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'products.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      products: products.map(p => ({
        id: p.id,
        title: p.title || p.productType,
        productType: p.productType,
        status: p.status,
        price: p.price || 0,
        revenue: p.revenue || 0,
        elementCount: p.elementCount || 0,
        isPublished: p.isPublished || false,
        publishedUrl: p.publishedUrl || '',
        createdAt: p.createdAt,
        completedAt: p.completedAt,
        salesTitle: p.salesTitle || '',
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
  const summary = buildTelegramSummary(products);
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
