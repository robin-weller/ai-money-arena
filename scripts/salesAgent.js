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

function buildSalesPrompt(product, productContent) {
  let brandSection = '';
  try {
    const brand = getBrand();
    brandSection = `BRAND: ${brand.name} — "${brand.tagline}"
Include the brand name "${brand.name}" naturally once in the description.
Keep tone simple, clean, and benefit-focused.
You must use the predefined brand. Do not invent new styles or brand names.

`;
  } catch { /* brand load failure is non-fatal */ }

  return `You are an Etsy SEO expert creating a product listing for a productivity printable digital download.

${brandSection}Product type: ${product.productType}
Product title: ${product.title}
Target audience: ${product.audience || 'productivity enthusiasts'}
Product content preview:
${productContent.slice(0, 1200)}

Create an Etsy-optimised listing. Return ONLY valid JSON with this exact structure (no markdown, no explanation):

{
  "title": "...",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12", "tag13"],
  "description": "full Etsy product description 150-250 words: what it is, what's included, benefits, how to use, ideal for who",
  "category": "Paper & Party Supplies",
  "price": 4.99,
  "shortSummary": "outcome-driven sentence under 80 chars — what the buyer will achieve (e.g. 'Plan your week in minutes and stop feeling overwhelmed')"
}

TITLE RULES (critical — follow exactly):
- Format: [Primary Keyword] | [Clear Benefit for ${product.audience || 'users'}] | [Format]
- Examples:
    "Weekly Productivity Planner Printable | Plan Your Week in Minutes | Instant Download PDF"
    "30-Day Habit Tracker Printable | Build Better Habits Fast | Digital Download"
    "Daily Schedule Template | Stay Focused & Get More Done | Printable PDF"
- The primary keyword must come FIRST (not the brand name)
- Must include the main search keyword at the start
- Must include a clear benefit (what the buyer gets/feels)
- Must end with the format: Printable, PDF, Digital Download, or Instant Download PDF
- Do NOT start the title with the brand name "${(brandSection.match(/Brand: ([^—]+)/) || [])[1] || 'Lazy Whippet'}}"
- Under 140 characters

OTHER RULES:
- Exactly 13 tags, each under 20 characters
- Include audience-specific tags for: ${product.audience || 'productivity enthusiasts'}
- Price between 3.00 and 7.00
- No placeholders
- Tags should be common Etsy search terms for productivity printables
- Description should mention the target audience (${product.audience || 'productivity enthusiasts'}) and speak to their specific needs
- Brand name may appear once in the description only, not the title
- shortSummary must be outcome-driven and specific — avoid generic phrases like "Get more done", "Stay productive", "Boost productivity", "Be more organised"
- shortSummary should answer: what will the buyer actually achieve? (e.g. "Plan your week in minutes", "Stop forgetting habits with a simple daily grid", "Track every book you read and retain more")`;
}

async function run() {
  console.log('[sales-agent] Starting...');
  let products = loadProducts();
  const ready = products.filter(p => p.status === 'ready_to_ship');

  if (!ready.length) { console.log('[sales-agent] No products to process. Exiting.'); return; }
  console.log(`[sales-agent] Processing ${ready.length} product(s)`);

  for (const product of ready) {
    console.log(`[sales-agent] Processing: ${product.id}`);
    const productPath = path.join(__dirname, '..', product.productOutputPath);
    if (!fs.existsSync(productPath)) { console.log(`[sales-agent] Missing product file: ${productPath}`); continue; }

    const productContent = fs.readFileSync(productPath, 'utf8');
    const prompt = buildSalesPrompt(product, productContent);

    let salesData;
    let callCost = 0;
    const result = await callGemini(prompt, { timeoutMs: 30000 });

    if (result.success === false) {
      console.error(`[sales-agent] Gemini failed for ${product.id}: ${result.error} — ${result.message}`);
      const idx0 = products.findIndex(p => p.id === product.id);
      products[idx0].aiFailureCount = (products[idx0].aiFailureCount || 0) + 1;
      products[idx0].lastError = result.error;
      if (products[idx0].aiFailureCount > 3) {
        products[idx0].needsHumanReview = true;
        console.error(`[sales-agent] Product ${product.id} exceeded failure limit, flagged for human review`);
      }
      continue;
    }

    try {
      callCost = result.usage?.cost || 0;
      const text = result.text.replace(/```json\n?|\n?```/g, '').trim();
      salesData = JSON.parse(text);
    } catch (err) {
      console.error(`[sales-agent] JSON parse error for ${product.id}: ${err.message}`);
      const idx0 = products.findIndex(p => p.id === product.id);
      products[idx0].aiFailureCount = (products[idx0].aiFailureCount || 0) + 1;
      products[idx0].lastError = 'invalid_response';
      continue;
    }

    if (!salesData.title || !Array.isArray(salesData.tags) || salesData.tags.length < 10) {
      console.log(`[sales-agent] Invalid sales data for ${product.id}, skipping`);
      continue;
    }

    // Validate title format: must not start with brand name, must include format word
    try {
      const brand = getBrand();
      const title = salesData.title;
      const formatWords = ['printable', 'pdf', 'digital download', 'instant download'];
      const hasFormat = formatWords.some(w => title.toLowerCase().includes(w));
      if (title.toLowerCase().startsWith(brand.name.toLowerCase())) {
        console.log(`[sales-agent] Warning: title starts with brand name for ${product.id} — "${title}"`);
      }
      if (!hasFormat) {
        console.log(`[sales-agent] Warning: title missing format word for ${product.id} — "${title}"`);
      }
      if (salesData.description && !salesData.description.includes(brand.name)) {
        console.log(`[sales-agent] Warning: brand name "${brand.name}" missing from description for ${product.id}`);
      }
    } catch { /* non-fatal */ }

    const salesPath = path.join(__dirname, '..', product.salesOutputPath);
    fs.mkdirSync(path.dirname(salesPath), { recursive: true });
    fs.writeFileSync(salesPath, JSON.stringify(salesData, null, 2));

    const idx = products.findIndex(p => p.id === product.id);
    products[idx] = {
      ...product,
      status: 'ready_to_market',
      price: Number(salesData.price) || 4.99,
      salesTitle: salesData.title,
      salesCompletedAt: new Date().toISOString(),
      aiCostTotal: (product.aiCostTotal || 0) + callCost,
      aiCalls: (product.aiCalls || 0) + 1,
    };
    console.log(`[sales-agent] Done: ${product.id} price=$${salesData.price} cost=$${callCost.toFixed(5)} → ready_to_market`);
  }

  saveProducts(products);
  console.log('[sales-agent] Done.');
}

run().catch(err => { console.error('[sales-agent] Fatal:', err.message); process.exit(1); });
