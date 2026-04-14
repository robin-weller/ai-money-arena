'use strict';
const fs = require('fs');
const path = require('path');
const { callGemini } = require('./gemini.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

function buildSalesPrompt(product, productContent) {
  return `You are an Etsy SEO expert creating a product listing for a productivity printable digital download.

Product type: ${product.productType}
Product title: ${product.title}
Product content preview:
${productContent.slice(0, 1200)}

Create an Etsy-optimised listing. Return ONLY valid JSON with this exact structure (no markdown, no explanation):

{
  "title": "keyword-rich Etsy title under 140 chars, include words like printable, planner, digital download, instant download, PDF",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12", "tag13"],
  "description": "full Etsy product description 150-250 words: what it is, what's included, benefits, how to use, ideal for who",
  "category": "Paper & Party Supplies",
  "price": 4.99,
  "shortSummary": "one sentence under 80 chars"
}

RULES:
- Exactly 13 tags, each under 20 characters
- Price between 3.00 and 7.00
- No placeholders
- Tags should be common Etsy search terms for productivity printables
- Description should be natural, benefit-focused language`;
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
    try {
      const result = await callGemini(prompt, { timeoutMs: 30000 });
      const text = result.text.replace(/```json\n?|\n?```/g, '').trim();
      salesData = JSON.parse(text);
    } catch (err) {
      console.error(`[sales-agent] Error for ${product.id}: ${err.message}`);
      continue;
    }

    if (!salesData.title || !Array.isArray(salesData.tags) || salesData.tags.length < 10) {
      console.log(`[sales-agent] Invalid sales data for ${product.id}, skipping`);
      continue;
    }

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
    };
    console.log(`[sales-agent] Done: ${product.id} price=$${salesData.price} → ready_to_market`);
  }

  saveProducts(products);
  console.log('[sales-agent] Done.');
}

run().catch(err => { console.error('[sales-agent] Fatal:', err.message); process.exit(1); });
