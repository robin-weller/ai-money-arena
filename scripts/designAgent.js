'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { marked } = require('marked');
const { getBrand, getTheme, THEME_IDS } = require('./brand.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')); } catch { return []; }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

function loadTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTheme(template, brand, theme) {
  return template
    .replace(/\{\{BG\}\}/g, theme.background)
    .replace(/\{\{PRIMARY\}\}/g, theme.primary)
    .replace(/\{\{SECONDARY\}\}/g, theme.secondary)
    .replace(/\{\{ACCENT\}\}/g, theme.accent)
    .replace(/\{\{TEXT\}\}/g, theme.text)
    .replace(/\{\{FONT_PRIMARY\}\}/g, brand.fontPrimary)
    .replace(/\{\{FONT_SECONDARY\}\}/g, brand.fontSecondary)
    .replace(/\{\{BRAND_NAME\}\}/g, escapeHtml(brand.name));
}

function wrapSections(html) {
  // Wrap each h2 block in a .section div for page-break-inside: avoid
  // Also insert explicit page breaks before large tables (>20 rows)
  const lines = html.split('\n');
  const out = [];
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/<h2[^>]*>/.test(line)) {
      if (inSection) out.push('</div>'); // close previous section
      out.push('<div class="section">');
      inSection = true;
    }
    out.push(line);
  }
  if (inSection) out.push('</div>');
  return out.join('\n');
}

function insertPageBreaksForLargeTables(html) {
  // Find <table> elements with many <tr> rows and split them
  return html.replace(/<table[\s\S]*?<\/table>/g, (tableHtml) => {
    const rows = (tableHtml.match(/<tr/g) || []).length;
    if (rows > 20) {
      // Wrap in a page-break div
      return `<div class="page-break"></div>${tableHtml}`;
    }
    return tableHtml;
  });
}

function renderProductHtml(productContent, product, brand, theme) {
  const rawHtml = marked.parse(productContent);
  const sectioned = wrapSections(rawHtml);
  const contentHtml = insertPageBreaksForLargeTables(sectioned);
  let html = loadTemplate('product.html');
  html = applyTheme(html, brand, theme);
  html = html.replace(/\{\{TITLE\}\}/g, escapeHtml(product.title));
  html = html.replace(/\{\{CONTENT\}\}/g, contentHtml);
  html = html.replace(/\{\{THEME_NAME\}\}/g, escapeHtml(theme.name));
  return html;
}

function renderCoverHtml(product, salesData, brand, theme) {
  const summary = salesData.shortSummary ||
    (salesData.description ? salesData.description.slice(0, 120) : null) ||
    product.title;
  let html = loadTemplate('cover.html');
  html = applyTheme(html, brand, theme);
  html = html.replace(/\{\{TITLE\}\}/g, escapeHtml(product.title));
  html = html.replace(/\{\{SUMMARY\}\}/g, escapeHtml(summary));
  html = html.replace(/\{\{NICHE\}\}/g, escapeHtml(product.niche || 'productivity'));
  return html;
}

function renderMockupHtml(product, salesData, brand, theme) {
  const summary = salesData.shortSummary ||
    (salesData.description ? salesData.description.slice(0, 120) : null) ||
    product.title;
  const tags = (salesData.tags || []).slice(0, 4);
  const bulletsHtml = tags.map(tag =>
    `<div class="bullet-item"><div class="feature-dot"></div><span>${escapeHtml(tag)}</span></div>`
  ).join('\n      ');
  let html = loadTemplate('mockup.html');
  html = applyTheme(html, brand, theme);
  html = html.replace(/\{\{TITLE\}\}/g, escapeHtml(product.title));
  html = html.replace(/\{\{SUMMARY\}\}/g, escapeHtml(summary));
  html = html.replace(/\{\{BULLETS\}\}/g, bulletsHtml);
  return html;
}

async function run() {
  console.log('[design-agent] Starting...');
  const products = loadProducts();
  const eligible = products.filter(p => p.status === 'ready_to_distribute');

  if (!eligible.length) {
    console.log('[design-agent] No products in ready_to_distribute state. Exiting.');
    return;
  }

  console.log(`[design-agent] Processing ${eligible.length} product(s)...`);

  const browser = await chromium.launch();
  let successCount = 0;
  let errorCount = 0;

  try {
    for (const product of eligible) {
      console.log(`[design-agent] Processing: ${product.id} — ${product.title}`);

      const productDir = path.join(__dirname, '..', 'outputs', 'products', product.id);
      const productMdPath = path.join(productDir, 'product.md');
      const salesJsonPath = path.join(productDir, 'sales.json');

      if (!fs.existsSync(productMdPath)) {
        console.error(`[design-agent] ERROR: Missing product.md for ${product.id}, skipping.`);
        errorCount++;
        continue;
      }

      if (!fs.existsSync(salesJsonPath)) {
        console.error(`[design-agent] ERROR: Missing sales.json for ${product.id}, skipping.`);
        errorCount++;
        continue;
      }

      let brand, theme;
      try {
        brand = getBrand();
        const themeId = THEME_IDS.includes(product.themeId) ? product.themeId : 'themeA';
        if (!THEME_IDS.includes(product.themeId)) {
          console.warn(`[design-agent] Invalid themeId "${product.themeId}", defaulting to themeA.`);
        }
        theme = getTheme(themeId);
      } catch (err) {
        console.error(`[design-agent] ERROR: Failed to load brand/theme for ${product.id}: ${err.message}, skipping.`);
        errorCount++;
        continue;
      }

      let productMdContent, salesData;
      try {
        productMdContent = fs.readFileSync(productMdPath, 'utf8');
        salesData = JSON.parse(fs.readFileSync(salesJsonPath, 'utf8'));
      } catch (err) {
        console.error(`[design-agent] ERROR: Failed to read files for ${product.id}: ${err.message}, skipping.`);
        errorCount++;
        continue;
      }

      // Ensure output directory exists
      fs.mkdirSync(productDir, { recursive: true });

      const relBase     = `outputs/products/${product.id}`;
      const htmlPath    = path.join(productDir, 'product.html');
      const pdfPath     = path.join(productDir, 'product.pdf');
      const coverPath   = path.join(productDir, 'cover.png');
      const mockupPath  = path.join(productDir, 'mockup-1.png');

      try {
        // Render HTML files
        const productHtml = renderProductHtml(productMdContent, product, brand, theme);
        const coverHtml   = renderCoverHtml(product, salesData, brand, theme);
        const mockupHtml  = renderMockupHtml(product, salesData, brand, theme);

        // Save product.html to disk
        fs.writeFileSync(htmlPath, productHtml);
        console.log(`[design-agent]   Saved product.html`);

        const page = await browser.newPage();

        // Render PDF
        await page.setContent(productHtml, { waitUntil: 'domcontentloaded' });
        await page.pdf({
          path: pdfPath,
          format: 'A4',
          printBackground: true,
          margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
        });
        console.log(`[design-agent]   Saved product.pdf`);

        // Render cover.png
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.setContent(coverHtml, { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: coverPath, type: 'png' });
        console.log(`[design-agent]   Saved cover.png`);

        // Render mockup-1.png
        await page.setContent(mockupHtml, { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: mockupPath, type: 'png' });
        console.log(`[design-agent]   Saved mockup-1.png`);

        await page.close();

        // Update product state
        const idx = products.findIndex(p => p.id === product.id);
        if (idx !== -1) {
          products[idx].status = 'qa_pending';
          products[idx].designReady = true;
          products[idx].designOutputPaths = {
            html: `${relBase}/product.html`,
            pdf: `${relBase}/product.pdf`,
            cover: `${relBase}/cover.png`,
            mockup: `${relBase}/mockup-1.png`,
          };
          products[idx].designCompletedAt = new Date().toISOString();
        }
        saveProducts(products);
        console.log(`[design-agent]   Status → qa_pending`);
        successCount++;
      } catch (err) {
        console.error(`[design-agent] ERROR: Playwright rendering failed for ${product.id}: ${err.message}`);
        errorCount++;
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[design-agent] Done. Success: ${successCount}, Errors: ${errorCount}`);
}

run().catch(err => {
  console.error('[design-agent] Fatal:', err.message);
  process.exit(1);
});
