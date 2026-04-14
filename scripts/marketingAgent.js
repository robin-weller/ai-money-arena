'use strict';
const fs = require('fs');
const path = require('path');
const { callGemini } = require('./gemini.js');
const { getBrand, describeTheme } = require('./brand.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

function buildMarketingPrompt(product, salesData) {
  let brandSection = '';
  try {
    const brand = getBrand();
    const themeId = product.themeId || 'themeA';
    const themeDesc = describeTheme(themeId);
    brandSection = `BRAND: ${brand.name} — "${brand.tagline}"
Visual theme for thumbnail suggestions: ${themeDesc}
Use these exact colors in thumbnail text suggestions (e.g. "white background, blue accents" for themeA).
You must use the predefined brand and theme. Do not invent new styles or colors.

`;
  } catch { /* non-fatal */ }

  return `You are a digital product marketing expert specialising in Etsy marketplace optimisation.

${brandSection}Product: ${product.title}
Type: ${product.productType}
Primary listing title: ${salesData.title}
Tags: ${(salesData.tags || []).join(', ')}
Description: ${(salesData.description || '').slice(0, 300)}

Create marketplace marketing materials. Return ONLY valid JSON (no markdown, no explanation):

{
  "alternativeTitles": [
    "alternative Etsy title A for A/B testing (under 140 chars)",
    "alternative Etsy title B for A/B testing (under 140 chars)",
    "alternative Etsy title C for A/B testing (under 140 chars)"
  ],
  "keywordVariations": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6", "kw7", "kw8", "kw9", "kw10"],
  "thumbnailTextSuggestions": [
    "Thumbnail text 1 under 30 chars",
    "Thumbnail text 2 under 30 chars",
    "Thumbnail text 3 under 30 chars"
  ],
  "positioningAngles": [
    "positioning angle 1 in one sentence",
    "positioning angle 2 in one sentence",
    "positioning angle 3 in one sentence"
  ],
  "targetBuyer": "one sentence: who is this for",
  "mainBenefit": "single most compelling benefit in one sentence"
}

Focus on Etsy search and conversion. No social media posts. No placeholders.`;
}

async function run() {
  console.log('[marketing-agent] Starting...');
  let products = loadProducts();
  const ready = products.filter(p => p.status === 'ready_to_market');

  if (!ready.length) { console.log('[marketing-agent] No products to process. Exiting.'); return; }
  console.log(`[marketing-agent] Processing ${ready.length} product(s)`);

  for (const product of ready) {
    console.log(`[marketing-agent] Processing: ${product.id}`);
    const salesPath = path.join(__dirname, '..', product.salesOutputPath);
    if (!fs.existsSync(salesPath)) { console.log(`[marketing-agent] Missing sales file: ${salesPath}`); continue; }

    let salesData;
    try { salesData = JSON.parse(fs.readFileSync(salesPath, 'utf8')); }
    catch (err) { console.log(`[marketing-agent] Sales read error: ${err.message}`); continue; }

    const prompt = buildMarketingPrompt(product, salesData);

    let marketingData;
    let callCost = 0;
    try {
      const result = await callGemini(prompt, { timeoutMs: 30000 });
      callCost = result.usage?.cost || 0;
      const text = result.text.replace(/```json\n?|\n?```/g, '').trim();
      marketingData = JSON.parse(text);
    } catch (err) {
      console.error(`[marketing-agent] Error for ${product.id}: ${err.message}`);
      continue;
    }

    const marketingPath = path.join(__dirname, '..', product.marketingOutputPath);
    fs.mkdirSync(path.dirname(marketingPath), { recursive: true });
    fs.writeFileSync(marketingPath, JSON.stringify(marketingData, null, 2));

    const idx = products.findIndex(p => p.id === product.id);
    products[idx] = {
      ...product,
      status: 'ready_to_distribute',
      marketingCompletedAt: new Date().toISOString(),
      aiCostTotal: (product.aiCostTotal || 0) + callCost,
      aiCalls: (product.aiCalls || 0) + 1,
    };
    console.log(`[marketing-agent] Done: ${product.id} cost=$${callCost.toFixed(5)} → ready_to_distribute`);
  }

  saveProducts(products);
  console.log('[marketing-agent] Done.');
}

run().catch(err => { console.error('[marketing-agent] Fatal:', err.message); process.exit(1); });
