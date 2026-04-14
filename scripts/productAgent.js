'use strict';
const fs = require('fs');
const path = require('path');
const { callGemini } = require('./gemini.js');
const { getBrand, pickRandomTheme, describeTheme } = require('./brand.js');

const PRODUCTS_PATH = path.join(__dirname, '../state/products.json');
const OUTPUTS_DIR = path.join(__dirname, '../outputs/products');

const PRODUCT_TYPES = [
  {
    type: 'daily-planner',
    label: 'Daily Planner Printable',
    keywords: ['daily', 'planner', 'schedule'],
    audience: 'busy professionals',
    focus: 'plan one day at a time with priorities, time blocks, and a focused task list',
    titleTemplate: 'Daily Planner Printable | Plan Your Day with Clarity | Instant Download PDF',
  },
  {
    type: 'weekly-planner',
    label: 'Weekly Planner Printable',
    keywords: ['weekly', 'planner', 'week'],
    audience: 'busy professionals',
    focus: 'plan and review a full week with top priorities, daily tasks, and a weekly goal',
    titleTemplate: 'Weekly Priority Planner Printable | Stay Focused & Organised | Instant Download PDF',
  },
  {
    type: 'habit-tracker',
    label: 'Habit Tracker Printable',
    keywords: ['habit', 'tracker', '30-day'],
    audience: 'people building new habits',
    focus: 'track daily habits over 30 days with a simple checkbox grid — no dates pre-filled',
    titleTemplate: 'Habit Tracker Printable | Build Better Habits in 30 Days | Instant Download PDF',
  },
  {
    type: 'goal-tracker',
    label: 'Goal Tracker Printable',
    keywords: ['goal', 'tracker', 'action'],
    audience: 'entrepreneurs and goal-setters',
    focus: 'define, break down, and track progress on one meaningful goal with action steps',
    titleTemplate: 'Goal Tracker Printable | Break Down Big Goals & Take Action | Instant Download PDF',
  },
  {
    type: 'time-blocking-template',
    label: 'Time Blocking Schedule Printable',
    keywords: ['time', 'blocking', 'schedule'],
    audience: 'busy professionals',
    focus: 'block out time for tasks in a structured daily schedule with hour-by-hour slots',
    titleTemplate: 'Time Blocking Schedule Printable | Take Control of Your Day | Instant Download PDF',
  },
  {
    type: 'task-priority-system',
    label: 'Task Priority Sheet Printable',
    keywords: ['task', 'priority', 'todo'],
    audience: 'overwhelmed professionals',
    focus: 'sort tasks by urgency and importance using a simple priority matrix or ranked list',
    titleTemplate: 'Task Priority Planner Printable | Focus on What Matters Most | Instant Download PDF',
  },
  {
    type: 'morning-routine-checklist',
    label: 'Morning Routine Checklist Printable',
    keywords: ['morning', 'routine', 'checklist'],
    audience: 'people building a consistent morning routine',
    focus: 'a single-page checklist for completing a morning routine step by step',
    titleTemplate: 'Morning Routine Checklist Printable | Win Your Morning Every Day | Instant Download PDF',
  },
  {
    type: 'meal-planner',
    label: 'Weekly Meal Planner Printable',
    keywords: ['meal', 'planner', 'weekly'],
    audience: 'home cooks and busy families',
    focus: 'plan meals for the week with a simple day-by-day grid and a shopping list section',
    titleTemplate: 'Weekly Meal Planner Printable | Eat Better & Save Time | Instant Download PDF',
  },
  {
    type: 'study-planner',
    label: 'Study Session Planner Printable',
    keywords: ['study', 'schedule', 'student'],
    audience: 'students',
    focus: 'plan a focused study session with subject, goals, time blocks, and a review section',
    titleTemplate: 'Study Planner Printable | Study Smarter Not Harder | Instant Download PDF',
  },
  {
    type: 'project-planner',
    label: 'Project Planner Printable',
    keywords: ['project', 'planning', 'template'],
    audience: 'freelancers and project managers',
    focus: 'map out one project with milestones, tasks, deadlines, and a status tracker',
    titleTemplate: 'Project Planner Printable | Plan & Deliver Projects on Time | Instant Download PDF',
  },
  {
    type: 'fitness-habit-tracker',
    label: 'Fitness Habit Tracker Printable',
    keywords: ['fitness', 'workout', 'habit'],
    audience: 'people starting a fitness routine',
    focus: 'track workout habits, movement goals, and weekly progress with a simple daily grid',
    titleTemplate: 'Fitness Habit Tracker Printable | Build Your Workout Habit | Instant Download PDF',
  },
  {
    type: 'adhd-planner',
    label: 'ADHD Daily Planner Printable',
    keywords: ['adhd', 'daily', 'focus'],
    audience: 'adults with ADHD',
    focus: 'a simple, low-overwhelm daily planner with brain dump, top 3 tasks, and check-ins',
    titleTemplate: 'ADHD Daily Planner Printable | Stay Focused One Day at a Time | Instant Download PDF',
  },
  {
    type: 'student-study-tracker',
    label: 'Student Grade & Assignment Tracker Printable',
    keywords: ['student', 'study', 'grade'],
    audience: 'high school and university students',
    focus: 'track assignments, due dates, and grades by subject across a semester',
    titleTemplate: 'Student Assignment Tracker Printable | Stay on Top of Deadlines | Instant Download PDF',
  },
  {
    type: 'morning-routine-habit-tracker',
    label: 'Morning Routine Habit Tracker Printable',
    keywords: ['morning', 'habit', 'routine'],
    audience: 'people building a consistent morning practice',
    focus: 'track morning habits daily for a month with a simple grid and reflection space',
    titleTemplate: 'Morning Routine Tracker Printable | Build Your Perfect Morning | Instant Download PDF',
  },
  {
    type: 'budget-planner',
    label: 'Monthly Budget Tracker Printable',
    keywords: ['budget', 'expense', 'monthly'],
    audience: 'people taking control of their finances',
    focus: 'track monthly income, expenses by category, and savings goal in one sheet',
    titleTemplate: 'Monthly Budget Tracker Printable | Take Control of Your Money | Instant Download PDF',
  },
  {
    type: 'reading-tracker',
    label: 'Reading Log Printable',
    keywords: ['reading', 'book', 'log'],
    audience: 'book lovers and reading challenge participants',
    focus: 'log books read, track reading progress, and capture key takeaways',
    titleTemplate: 'Reading Log Printable | Track Every Book You Read | Instant Download PDF',
  },
  {
    type: 'self-care-tracker',
    label: 'Self-Care Tracker Printable',
    keywords: ['self-care', 'wellness', 'health'],
    audience: 'people prioritising mental and physical wellbeing',
    focus: 'track daily self-care habits like sleep, hydration, movement, and mood',
    titleTemplate: 'Self-Care Tracker Printable | Prioritise Your Wellbeing Daily | Instant Download PDF',
  },
  {
    type: 'work-from-home-planner',
    label: 'Work From Home Daily Planner Printable',
    keywords: ['work', 'home', 'remote'],
    audience: 'remote workers',
    focus: 'structure a productive work-from-home day with start ritual, tasks, breaks, and wrap-up',
    titleTemplate: 'Work From Home Planner Printable | Stay Productive Working Remotely | Instant Download PDF',
  },
  {
    type: 'content-creator-planner',
    label: 'Content Creator Weekly Planner Printable',
    keywords: ['content', 'creator', 'social'],
    audience: 'content creators and social media managers',
    focus: 'plan weekly content ideas, posting schedule, and creation tasks in one view',
    titleTemplate: 'Content Creator Planner Printable | Plan & Post With Ease | Instant Download PDF',
  },
  {
    type: 'gratitude-journal',
    label: 'Daily Gratitude Journal Printable',
    keywords: ['gratitude', 'journal', 'mindset'],
    audience: 'people building a positive mindset practice',
    focus: 'a daily gratitude journal with prompts for three things to be grateful for and a reflection',
    titleTemplate: 'Daily Gratitude Journal Printable | Shift Your Mindset Every Day | Instant Download PDF',
  },
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

// Placeholder patterns that indicate genuinely unfilled template slots
const REAL_PLACEHOLDER_RE = /\[(?:YOUR|INSERT|FILL|ADD|ENTER|WRITE|PUT|GOAL HERE|NAME HERE|HABIT HERE|TYPE HERE|TOPIC HERE)[^\]]*\]/i;

function countElements(content, productType) {
  // Table data rows: lines starting with | but NOT separator rows (|---|)
  const tableRows = (content.match(/^\|(?![-|])/gm) || []).length;

  // Checkboxes: handle □ Unicode, [ ] markdown style, and [x] checked
  const checkboxes = (content.match(/^[\s]*[-*+]\s+(?:\[[ xX]\]|□)/gm) || []).length;

  // Numbered list items
  const numbered = (content.match(/^\d+\.\s+\S/gm) || []).length;

  // Bullet points (excluding checkbox lines)
  const allBullets = (content.match(/^[\s]*[-*+]\s+\S/gm) || []).length;
  const plainBullets = Math.max(allBullets - checkboxes, 0);

  // Heading-based sections (h2/h3 indicate structural sections)
  const sections = (content.match(/^#{2,3}\s+\S/gm) || []).length;

  // Field-like lines: lines containing common planner field patterns
  const fieldLines = (content.match(/^.*(?:Goal:|Priority:|Task:|Note:|Date:|Day \d|Week \d|Morning|Evening|Reflection|Intention|Review).*$/gmi) || []).length;

  const total = tableRows + checkboxes + numbered + plainBullets + Math.max(sections - 1, 0) + Math.max(fieldLines - tableRows, 0);

  return {
    total,
    breakdown: { tableRows, checkboxes, numbered, plainBullets, sections, fieldLines },
  };
}

function validateProduct(content, productType) {
  if (!content || content.length < 600) {
    return { valid: false, reason: `Too short (${content ? content.length : 0} chars, need ≥600)` };
  }

  // Only reject genuinely unfilled placeholders, not example content like [Priority Task 1]
  if (REAL_PLACEHOLDER_RE.test(content)) {
    const sample = content.match(REAL_PLACEHOLDER_RE)?.[0];
    return { valid: false, reason: `Contains unfilled placeholder: ${sample}` };
  }

  // Reject fixed dates — months, specific day names used as row labels
  const FIXED_DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
  if (FIXED_DATE_RE.test(content)) {
    const sample = content.match(FIXED_DATE_RE)?.[0];
    return { valid: false, reason: `Contains fixed date/month: "${sample}" — products must be reusable` };
  }

  // Reject sequential day labels used as fixed structure (e.g. "| Day 1 |" or "Day 1:" repeated)
  // Allow "Day ______" (blank fill-in) but not "Day 1", "Day 2", "Day 15" etc.
  const SEQUENTIAL_DAY_RE = /\bDay\s+\d+\b/gi;
  const dayMatches = content.match(SEQUENTIAL_DAY_RE) || [];
  if (dayMatches.length >= 3) {
    return { valid: false, reason: `Contains sequential day labels (${dayMatches.slice(0,3).join(', ')}…) — use blank rows instead` };
  }

  // Reject markdown [ ] checkbox syntax — must use □ Unicode for print-safe checkboxes
  const MARKDOWN_CHECKBOX_RE = /^[\s]*[-*+]\s+\[\s\]/gm;
  const markdownCheckboxes = content.match(MARKDOWN_CHECKBOX_RE) || [];
  if (markdownCheckboxes.length > 0) {
    return { valid: false, reason: `Contains markdown "[ ]" checkbox syntax (${markdownCheckboxes.length} found) — use □ Unicode character instead for print-safe checkboxes` };
  }

  // Reject tables that have a separator row but no meaningful column headers
  // A header row directly above | --- | must contain at least one non-empty, non-dashes cell
  const TABLE_BLOCK_RE = /^(\|[^\n]+\|)\n\|[\s\-|:]+\|/gm;
  let tableMatch;
  while ((tableMatch = TABLE_BLOCK_RE.exec(content)) !== null) {
    const headerRow = tableMatch[1];
    const cells = headerRow.split('|').map(c => c.trim()).filter(Boolean);
    const emptyHeaders = cells.filter(c => !c || /^[-\s]+$/.test(c)).length;
    if (emptyHeaders === cells.length) {
      return { valid: false, reason: 'Table found with no column headers — every table must have descriptive headers (e.g. Task | Priority | Due Date | Status | Notes)' };
    }
  }


  const label = productType || 'unknown';
  console.log(`[product-agent] Element count for ${label}: total=${total} tables=${breakdown.tableRows} checkboxes=${breakdown.checkboxes} numbered=${breakdown.numbered} bullets=${breakdown.plainBullets} sections=${breakdown.sections} fields=${breakdown.fieldLines}`);

  // Detect multi-purpose products — too many distinct section types suggests combo product
  const sectionHeadings = (content.match(/^#{2,3}\s+.+$/gm) || []).map(h => h.toLowerCase());
  const hasPlanner = sectionHeadings.some(h => /planner|schedule|time.?block|daily|weekly/.test(h));
  const hasHabitTracker = sectionHeadings.some(h => /habit.?track|tracker|streak/.test(h));
  const hasJournal = sectionHeadings.some(h => /journal|gratitude|reflection|prompt/.test(h));
  const hasGoalTracker = sectionHeadings.some(h => /goal.?track|goal.?set|action.?plan/.test(h));
  const distinctToolCount = [hasPlanner, hasHabitTracker, hasJournal, hasGoalTracker].filter(Boolean).length;
  if (distinctToolCount >= 3) {
    return { valid: false, reason: `Product combines too many tools (${distinctToolCount} detected: planner=${hasPlanner} tracker=${hasHabitTracker} journal=${hasJournal} goal=${hasGoalTracker}) — must be single-purpose` };
  }

  // Minimum threshold — lower bar since tables alone are high-value
  const min = 10;
  if (total < min) {
    return { valid: false, reason: `Only ${total} usable elements (need ≥${min}): ${JSON.stringify(breakdown)}` };
  }

  return { valid: true, elementCount: total };
}

function buildPrompt(productType, productLabel, audience, focus, titleTemplate, existingContent, brandContext) {
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

${brandSection}TARGET AUDIENCE: ${audience}
This product is designed specifically for ${audience}. All language, structure, and features must reflect their specific needs and context. Use language that speaks directly to them.

PRODUCT FOCUS (ONE PURPOSE ONLY):
This product must solve ONE problem: ${focus}
Do NOT combine multiple tools into one product. Do NOT create a planner + habit tracker + journal all in one.
Every section must serve the same core purpose. If it doesn't fit the focus, leave it out.

TITLE RULE (CRITICAL):
The title (# heading at the top) must follow this exact format:
[Primary Keyword] | [Clear Benefit for ${audience}] | [Format]
Use this template as a guide: "${titleTemplate}"
Do NOT start with brand name. Do NOT use a generic title. Make it specific and benefit-driven.

PRODUCT REQUIREMENTS:
- Type: ${productLabel}
- Must be immediately printable and usable without any editing
- Minimum 30 usable rows/fields/checkboxes/elements
- Use markdown tables with clear, descriptive column headers (e.g. | Task | Priority | Due Date | Status | Notes |)
- Every table MUST include a header row — never leave headers blank or generic
- Use □ (Unicode U+25A1) for checkboxes in task/habit lists — do NOT use markdown "[ ]" syntax
- Each □ item must have enough surrounding space for comfortable handwriting
- Include a brief "How to Use" section (3-5 bullet points)
- No pre-filled dates, fixed calendar values, or sequential day labels like "Day 1, Day 2"
- No personal pre-fills — the buyer fills everything in themselves
- Products must be REUSABLE: not tied to a specific time period or person
- Use blank input fields: "Day ______", "Date: ______", "Start Date: ______"
- For habit/challenge trackers: blank rows where the user writes the habit name and fills daily checkboxes
- For planners: include "Date: ______" at the top of each page/section
- Column headers in tables should be structural, not date-specific (e.g. "Habit" | "M" | "T" | "W" | "Th" | "F" | "Sa" | "Su" | "✓")
- Rows in tracker tables: blank "______" in the habit/task column, □ in tracking columns (not [ ])
- No placeholders like [topic], [fill in here], [your goal] — use "______" for user-fillable fields
- Add subtle guidance text beneath each section header (one short sentence explaining what to do)
- Section labels must be clear and intuitive — user must understand each section without asking

PRINT USABILITY (CRITICAL):
- Ensure there is enough writing space in every row and field
- Table rows must have generous height — buyers will be writing by hand
- Use readable font-friendly markdown: avoid cramping content
- Blank lines between rows improve readability when printed
- Every field should feel spacious, not squeezed

STRUCTURE REQUIREMENTS for ${productLabel} (targeted at ${audience}):
- Title: follows the [Keyword] | [Benefit] | [Format] rule above
- How to Use: 3-5 bullet points written for ${audience}
- Main Section: Large table or grid with 20-30 blank-but-structured rows ready to fill in
- Secondary Section: Additional tracking or notes area with at least 10 blank fields (use "______")
- Reflection/Review Section: 5+ written question prompts the user answers by hand
- Footer: Short motivational line relevant to ${audience}

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
      title: chosen.titleTemplate || chosen.label,
      productType: chosen.type,
      audience: chosen.audience || 'productivity enthusiasts',
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

  const prompt = buildPrompt(
    product.productType,
    typeInfo.label,
    typeInfo.audience || product.audience || 'productivity enthusiasts',
    typeInfo.focus || `a focused ${typeInfo.label}`,
    typeInfo.titleTemplate || typeInfo.label,
    existingContent,
    brandContext
  );

  let content;
  let callCost = 0;
  const result = await callGemini(prompt, { timeoutMs: 90000 });

  const idx = products.findIndex(p => p.id === product.id);

  if (result.success === false) {
    console.error(`[product-agent] Gemini failed: ${result.error} — ${result.message}`);
    const failureCount = (products[idx].aiFailureCount || 0) + 1;
    products[idx].aiFailureCount = failureCount;
    products[idx].lastError = result.error;
    if (failureCount > 3) {
      products[idx].needsHumanReview = true;
      console.error(`[product-agent] Product ${product.id} exceeded failure limit, flagged for human review`);
    }
    saveProducts(products);
    return;
  }

  content = result.text;
  callCost = result.usage?.cost || 0;
  console.log(`[product-agent] Generated: ${content.length} chars cost=$${callCost.toFixed(5)}`);
  products[idx].aiCostTotal = (products[idx].aiCostTotal || 0) + callCost;
  products[idx].aiCalls = (products[idx].aiCalls || 0) + 1;

  const validation = validateProduct(content, product.productType);
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
