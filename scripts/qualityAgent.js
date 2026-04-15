'use strict';

const fs = require('fs');
const path = require('path');
const { THEME_IDS } = require('./brand.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const OUTPUTS_DIR   = path.join(__dirname, '../outputs/products');
const REPO_ROOT     = path.join(__dirname, '..');

const MAX_QA_RETRIES = 3;

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

function fileExists(relPath) {
  if (!relPath) return false;
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

/**
 * Run all QA checks on a product.
 * Returns { passed: true } or { passed: false, stage, reason }.
 */
function runChecks(product) {
  // 1. Product content
  if (!product.productOutputPath) {
    return { passed: false, stage: 'product', reason: 'productOutputPath not set' };
  }
  const productPath = path.join(REPO_ROOT, product.productOutputPath);
  if (!fs.existsSync(productPath)) {
    return { passed: false, stage: 'product', reason: 'product.md is missing' };
  }
  const productContent = fs.readFileSync(productPath, 'utf8');
  if (productContent.length < 200) {
    return { passed: false, stage: 'product', reason: 'product.md is too short or empty' };
  }
  if (/\[[A-Z][^\]]*\]/.test(productContent) || /\[(topic|name|insert|your|fill)\b/i.test(productContent)) {
    return { passed: false, stage: 'product', reason: 'product.md contains placeholder text' };
  }
  if (!product.title || product.title.length < 3) {
    return { passed: false, stage: 'product', reason: 'Product title is missing or too short' };
  }
  if (!product.niche) {
    return { passed: false, stage: 'product', reason: 'Product niche is not set' };
  }

  // 2. Sales package
  if (!product.salesOutputPath) {
    return { passed: false, stage: 'sales', reason: 'salesOutputPath not set' };
  }
  const salesPath = path.join(REPO_ROOT, product.salesOutputPath);
  if (!fs.existsSync(salesPath)) {
    return { passed: false, stage: 'sales', reason: 'sales.json is missing' };
  }
  let salesData;
  try { salesData = JSON.parse(fs.readFileSync(salesPath, 'utf8')); } catch {
    return { passed: false, stage: 'sales', reason: 'sales.json is invalid JSON' };
  }
  if (!salesData.title || salesData.title.length < 5) {
    return { passed: false, stage: 'sales', reason: 'sales.json has missing or invalid title' };
  }
  if (!salesData.description || salesData.description.length < 50) {
    return { passed: false, stage: 'sales', reason: 'sales.json has missing or too-short description' };
  }
  if (!salesData.price || Number(salesData.price) <= 0) {
    return { passed: false, stage: 'sales', reason: 'sales.json has missing or invalid price' };
  }
  if (!Array.isArray(salesData.tags) || salesData.tags.length < 5) {
    return { passed: false, stage: 'sales', reason: 'sales.json has too few tags' };
  }

  // 3. Marketing package
  if (!product.marketingOutputPath) {
    return { passed: false, stage: 'marketing', reason: 'marketingOutputPath not set' };
  }
  const marketingPath = path.join(REPO_ROOT, product.marketingOutputPath);
  if (!fs.existsSync(marketingPath)) {
    return { passed: false, stage: 'marketing', reason: 'marketing.json is missing' };
  }
  let marketingData;
  try { marketingData = JSON.parse(fs.readFileSync(marketingPath, 'utf8')); } catch {
    return { passed: false, stage: 'marketing', reason: 'marketing.json is invalid JSON' };
  }
  const hasMarketing = (
    (Array.isArray(marketingData.alternativeTitles) && marketingData.alternativeTitles.length > 0) ||
    (Array.isArray(marketingData.keywordVariations)  && marketingData.keywordVariations.length > 0) ||
    (Array.isArray(marketingData.positioningAngles)  && marketingData.positioningAngles.length > 0)
  );
  if (!hasMarketing) {
    return { passed: false, stage: 'marketing', reason: 'marketing.json has no usable content' };
  }

  // 4. Design assets
  if (!product.designReady) {
    return { passed: false, stage: 'design', reason: 'designReady is not set' };
  }
  const dp = product.designOutputPaths || {};
  if (!dp.pdf || !fileExists(dp.pdf)) {
    return { passed: false, stage: 'design', reason: 'product.pdf is missing' };
  }
  if (!dp.cover || !fileExists(dp.cover)) {
    return { passed: false, stage: 'design', reason: 'cover.png is missing' };
  }
  if (!dp.mockup || !fileExists(dp.mockup)) {
    return { passed: false, stage: 'design', reason: 'mockup-1.png is missing' };
  }
  if (!product.themeId || !THEME_IDS.includes(product.themeId)) {
    return { passed: false, stage: 'design', reason: `Invalid or missing themeId: "${product.themeId}"` };
  }

  return { passed: true };
}

function getRecoveryStatus(stage) {
  switch (stage) {
    case 'product':    return 'building';
    case 'sales':      return 'ready_to_ship';
    case 'marketing':  return 'ready_to_market';
    case 'design':     return 'ready_to_distribute';
    default:           return 'building';
  }
}

function getNextOwner(stage) {
  switch (stage) {
    case 'product':    return 'product-agent';
    case 'sales':      return 'sales-agent';
    case 'marketing':  return 'marketing-agent';
    case 'design':     return 'design-agent';
    default:           return 'product-agent';
  }
}

function writeQaResult(productId, result) {
  const outDir = path.join(OUTPUTS_DIR, productId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'qa.json'),
    JSON.stringify({
      passed:       result.passed,
      failureStage: result.stage   || null,
      reason:       result.reason  || null,
      checkedAt:    new Date().toISOString(),
      nextOwner:    result.nextOwner || null,
    }, null, 2)
  );
}

async function run() {
  console.log('[quality-agent] Starting...');
  let products = loadProducts();
  const pending = products.filter(p => p.status === 'qa_pending' && !p.needsHumanReview);

  if (!pending.length) {
    console.log('[quality-agent] No products pending QA. Exiting.');
    return;
  }

  console.log(`[quality-agent] Checking ${pending.length} product(s)`);
  let passed = 0, failed = 0, flagged = 0;

  for (const product of pending) {
    console.log(`[quality-agent] → ${product.id} (${product.title})`);
    const retryCount = product.qaRetryCount || 0;

    // Exceeded retry limit — flag for human review and stop bouncing
    if (retryCount >= MAX_QA_RETRIES) {
      console.log(`[quality-agent]   Exceeded ${MAX_QA_RETRIES} retries — flagging for human review`);
      const idx = products.findIndex(p => p.id === product.id);
      products[idx].needsHumanReview = true;
      products[idx].qaStatus = 'failed';
      products[idx].nextOwner = 'human';
      writeQaResult(product.id, {
        passed: false,
        stage:  'human',
        reason: `Exceeded ${MAX_QA_RETRIES} automated QA retries`,
        nextOwner: 'human',
      });
      saveProducts(products);
      flagged++;
      continue;
    }

    const result = runChecks(product);
    const idx = products.findIndex(p => p.id === product.id);

    if (result.passed) {
      products[idx].status           = 'publish_ready';
      products[idx].qaStatus         = 'passed';
      products[idx].qaFailureStage   = '';
      products[idx].qaFailureReason  = '';
      products[idx].nextOwner        = 'human';
      products[idx].publishReadyAt   = new Date().toISOString();
      writeQaResult(product.id, { passed: true, nextOwner: 'human' });
      saveProducts(products);
      console.log(`[quality-agent]   ✓ PASSED → publish_ready`);
      passed++;
    } else {
      const recoveryStatus = getRecoveryStatus(result.stage);
      const nextOwner      = getNextOwner(result.stage);
      products[idx].status          = recoveryStatus;
      products[idx].qaStatus        = 'failed';
      products[idx].qaFailureStage  = result.stage;
      products[idx].qaFailureReason = result.reason;
      products[idx].qaRetryCount    = retryCount + 1;
      products[idx].nextOwner       = nextOwner;
      // Reset designReady so design agent will re-process
      if (result.stage === 'design') {
        products[idx].designReady = false;
      }
      writeQaResult(product.id, { ...result, nextOwner });
      saveProducts(products);
      console.log(`[quality-agent]   ✗ FAILED (${result.stage}): ${result.reason} → ${recoveryStatus}`);
      failed++;
    }
  }

  console.log(`[quality-agent] Done. Passed: ${passed}, Failed: ${failed}, Flagged: ${flagged}`);
}

run().catch(err => {
  console.error('[quality-agent] Fatal:', err.message);
  process.exit(1);
});
