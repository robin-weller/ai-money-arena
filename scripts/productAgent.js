'use strict';
const fs = require('fs');
const path = require('path');
const { callGemini } = require('./gemini.js');
const { getBrand, pickRandomTheme, describeTheme } = require('./brand.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const OUTPUTS_DIR = path.join(__dirname, '../outputs/products');

const PRODUCT_TYPES = [
  { type: 'daily-planner', label: 'Daily Planner', keywords: ['daily', 'planner', 'schedule'] },
  { type: 'weekly-planner', label: 'Weekly Planner', keywords: ['weekly', 'planner', 'week'] },
  { type: 'habit-tracker', label: '30-Day Habit Tracker', keywords: ['habit', 'tracker', '30-day'] },
  { type: 'goal-tracker', label: 'Goal Tracker & Action Planner', keywords: ['goal', 'tracker', 'action'] },
  { type: 'time-blocking-template', label: 'Time Blocking Schedule Template', keywords: ['time', 'blocking', 'schedule'] },
  { type: 'task-priority-system', label: 'Task Priority & To-Do System', keywords: ['task', 'priority', 'todo'] },
  { type: 'morning-routine-checklist', label: 'Morning Routine Checklist', keywords: ['morning', 'routine', 'checklist'] },
  { type: 'meal-planner', label: 'Weekly Meal Planner', keywords: ['meal', 'planner', 'weekly'] },
  { type: 'study-planner', label: 'Study Schedule & Planner', keywords: ['study', 'schedule', 'student'] },
  { type: 'project-planner', label: 'Project Planning Template', keywords: ['project', 'planning', 'template'] },
  { type: 'fitness-habit-tracker', label: 'Fitness & Workout Habit Tracker', keywords: ['fitness', 'workout', 'habit'] },
  { type: 'adhd-planner', label: 'ADHD-Friendly Daily Planner', keywords: ['adhd', 'daily', 'focus'] },
  { type: 'student-study-tracker', label: 'Student Study & Grade Tracker', keywords: ['student', 'study', 'grade'] },
  { type: 'morning-routine-habit-tracker', label: 'Morning Routine Habit Tracker', keywords: ['morning', 'habit', 'routine'] },
  { type: 'budget-planner', label: 'Monthly Budget & Expense Tracker', keywords: ['budget', 'expense', 'monthly'] },
  { type: 'reading-tracker', label: 'Reading Log & Book Tracker', keywords: ['reading', 'book', 'log'] },
  { type: 'self-care-tracker', label: 'Self-Care & Wellness Tracker', keywords: ['self-care', 'wellness', 'health'] },
  { type: 'work-from-home-planner', label: 'Work From Home Daily Planner', keywords: ['work', 'home', 'remote'] },
  { type: 'content-creator-planner', label: 'Content Creator Weekly Planner', keywords: ['content', 'creator', 'social'] },
  { type: 'gratitude-journal', label: 'Daily Gratitude Journal Template', keywords: ['gratitude', 'journal', 'mindset'] },
];

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.mkdirSync(path.dirname(PRODUCTS_PATH), { recursive: true });
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

// Returns a simple fingerprint string for a product type
function makeFingerprint(type) {
  const t = PRODUCT_TYPES.find(p => p.type === type);
  return t ? t.keywords.slice().sort().join('|') : type;
}

// Check if a candidate type is too similar to any existing product
function isTooSimilar(candidateType, existingProducts) {
  const candidateFp = makeFingerprint(candidateType);
  const candidateKws = new Set(candidateFp.split('|'));
  for (const p of existingProducts) {
    const existingFp = makeFingerprint(p.productType);
    const existingKws = existingFp.split('|');
    const overlap = existingKws.filter(k => candidateKws.has(k)).length;
    // Same type or ≥2 overlapping keywords = too similar
    if (p.productType === candidateType || overlap >= 2) return true;
  }
  return false;
}

function pickProductType(existingProducts) {
  // Prefer types with no existing product at all
  const notUsed = PRODUCT_TYPES.filter(t => !existingProducts.some(p => p.productType === t.type));
  const dissimilar = notUsed.filter(t => !isTooSimilar(t.type, existingProducts));
  const pool = dissimilar.length > 0 ? dissimilar
    : notUsed.length > 0 ? notUsed
    : PRODUCT_TYPES.filter(t => !isTooSimilar(t.type, existingProducts));
  const fallback = pool.length > 0 ? pool : PRODUCT_TYPES;
  return fallback[Math.floor(Math.random() * fallback.length)];
}

function countElements(content) {
  const tableRows = (content.match(/^\|[^-|]/gm) || []).length;
  const checkboxes = (content.match(/^[-*] \[[ x]\]/gm) || []).length;
  const numbered = (content.match(/^\d+\.\s+\S/gm) || []).length;
  const bullets = (content.match(/^[-*] \S/gm) || []).length;
  return Math.max(tableRows, 0) + checkboxes + numbered + Math.max(bullets - checkboxes, 0);
}

function validateProduct(content) {
  if (!content || content.length < 600) return { valid: false, reason: 'Too short' };
  if (/\[[A-Z][^\]]*\]/.test(content)) return { valid: false, reason: 'Contains placeholders' };
  const elements = countElements(content);
  if (elements < 15) return { valid: false, reason: `Only ${elements} usable elements (need ≥15)` };
  return { valid: true, elementCount: elements };
}

function buildPrompt(productType, productLabel, existingContent, brandContext) {
  const expansion = existingContent
    ? `EXISTING DRAFT (expand this, do NOT restart):\n${existingContent}\n\n---\n\nExpand the above to be complete and fully usable.`
    : `Create a brand new ${productLabel} from scratch.`;

  const brandSection = brandContext ? `BRAND REQUIREMENTS:
- Brand: ${brandContext.brandName} — "${brandContext.tagline}"
- Visual theme: ${brandContext.themeDesc}
- Fonts: Primary ${brandContext.fontPrimary}, Secondary ${brandContext.fontSecondary}
- Add a footer line: "A ${brandContext.brandName} productivity tool"
- You must use the predefined brand and one of the allowed themes. Do not invent new styles or colors.

` : '';

  return `You are a productivity product creator making printable digital downloads for an Etsy marketplace.

${expansion}

${brandSection}PRODUCT REQUIREMENTS:
- Type: ${productLabel}
- Niche: productivity
- Must be immediately printable and usable without any editing
- Minimum 30 usable rows/fields/checkboxes/elements
- Use markdown tables with clear column headers
- Use checkboxes (- [ ]) for task/habit tracking sections
- Include a title (# heading) at the top
- Include a brief "How to Use" section
- No placeholders like [topic], [fill in here], [your goal], [date]
- Write actual example content — use generic-but-real values like "Monday", "Week 1", "Exercise", "Read 20 pages"

STRUCTURE REQUIREMENTS for ${productLabel}:
- Header: Title + one-line description
- How to Use: 3-5 bullet points explaining how to use this template
- Main Section: Large table or grid with 20-30 rows of real structure (days, tasks, habits, etc.)
- Secondary Section: Additional tracking or notes area with at least 10 more fields
- Reflection/Review Section: Weekly or daily review prompts (5+ items)
- Footer: Motivational quote or tip

OUTPUT: Return only the markdown product. No explanations. No commentary.`;
}

async function run() {
  console.log('[product-agent] Starting...');
  let products = loadProducts();

  // Find an in-progress product first, then create a new one
  let product = products.find(p => p.status === 'building');

  if (!product) {
    const chosen = pickProductType(products);
    console.log(`[product-agent] Selected type: ${chosen.type} (existing: ${products.map(p => p.productType).join(', ') || 'none'})`)

    const id = `product-${Date.now()}`;
    product = {
      id,
      title: chosen.label,
      productType: chosen.type,
      niche: 'productivity',
      status: 'building',
      owner: 'product-agent',
      isPublished: false,
      publishedUrl: '',
      price: 0,
      productOutputPath: `outputs/products/${id}/product.md`,
      salesOutputPath: `outputs/products/${id}/sales.json`,
      marketingOutputPath: `outputs/products/${id}/marketing.json`,
      distributionAttempts: 0,
      revenue: 0,
      createdAt: new Date().toISOString(),
      themeId: pickRandomTheme(),
    };
    products.push(product);
    saveProducts(products);
    console.log(`[product-agent] New product: id=${id} type=${chosen.type}`);
  } else {
    console.log(`[product-agent] Continuing: id=${product.id} type=${product.productType}`);
  }

  const outputPath = path.join(__dirname, '..', product.productOutputPath);
  let existingContent = null;
  if (fs.existsSync(outputPath)) {
    existingContent = fs.readFileSync(outputPath, 'utf8');
    console.log(`[product-agent] Existing content: ${existingContent.length} chars`);
  }

  const typeInfo = PRODUCT_TYPES.find(t => t.type === product.productType) || { label: product.productType };

  // Load brand and build context — themeId is locked once assigned
  const brand = getBrand();
  const themeId = product.themeId || pickRandomTheme();
  if (!product.themeId) {
    const idx0 = products.findIndex(p => p.id === product.id);
    products[idx0].themeId = themeId;
    saveProducts(products);
  }
  const brandContext = {
    brandName: brand.name,
    tagline: brand.tagline,
    themeId,
    themeDesc: describeTheme(themeId),
    fontPrimary: brand.fontPrimary,
    fontSecondary: brand.fontSecondary,
  };

  const prompt = buildPrompt(product.productType, typeInfo.label, existingContent, brandContext);

  let content;
  let callCost = 0;
  try {
    const result = await callGemini(prompt, { timeoutMs: 90000 });
    content = result.text;
    callCost = result.usage?.cost || 0;
    console.log(`[product-agent] Generated: ${content.length} chars cost=$${callCost.toFixed(5)}`);
  } catch (err) {
    console.error(`[product-agent] Gemini error: ${err.message}`);
    process.exit(1);
  }

  // Always persist cost regardless of validation outcome
  const idx = products.findIndex(p => p.id === product.id);
  products[idx].aiCostTotal = (products[idx].aiCostTotal || 0) + callCost;
  products[idx].aiCalls = (products[idx].aiCalls || 0) + 1;

  const validation = validateProduct(content);
  console.log(`[product-agent] Validation: valid=${validation.valid} reason=${validation.reason || 'ok'} elements=${validation.elementCount || 0}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);

  if (!validation.valid) {
    console.log('[product-agent] Product incomplete, will expand on next run');
    saveProducts(products);
    return;
  }

  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : typeInfo.label;

  products[idx] = {
    ...products[idx],
    title,
    status: 'ready_to_ship',
    elementCount: validation.elementCount,
    completedAt: new Date().toISOString(),
  };
  saveProducts(products);
  console.log(`[product-agent] Complete: title="${title}" elements=${validation.elementCount} cost=$${callCost.toFixed(5)} → ready_to_ship`);
}

run().catch(err => { console.error('[product-agent] Fatal:', err.message); process.exit(1); });
