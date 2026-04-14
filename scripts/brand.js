'use strict';

const fs = require('fs');
const path = require('path');

const BRAND_PATH = path.join(__dirname, '../state/brand.json');
const THEME_IDS = ['themeA', 'themeB', 'themeC'];

function getBrand() {
  try {
    return JSON.parse(fs.readFileSync(BRAND_PATH, 'utf8')).brand;
  } catch (err) {
    throw new Error(`Failed to load brand config: ${err.message}`);
  }
}

function getTheme(themeId) {
  const brand = getBrand();
  const theme = brand.themes[themeId];
  if (!theme) throw new Error(`Unknown themeId "${themeId}". Valid: ${THEME_IDS.join(', ')}`);
  return theme;
}

function pickRandomTheme() {
  return THEME_IDS[Math.floor(Math.random() * THEME_IDS.length)];
}

/**
 * Returns a human-readable description of a theme for use in AI prompts.
 */
function describeTheme(themeId) {
  const brand = getBrand();
  const theme = brand.themes[themeId];
  if (!theme) return themeId;
  return `${themeId} (${theme.name}): background=${theme.background}, primary=${theme.primary}, secondary=${theme.secondary}, accent=${theme.accent}, text=${theme.text}`;
}

module.exports = { getBrand, getTheme, pickRandomTheme, describeTheme, THEME_IDS };
