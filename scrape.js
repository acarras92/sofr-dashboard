const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');
const SCREENSHOT_FILE = path.join(DATA_DIR, 'latest_screenshot.png');

// Chatham public API endpoints discovered via network interception
const API_BASE = 'https://cf.com/public-api/public-rates';
const ENDPOINTS = {
  sofr1day:       `${API_BASE}/sofr1day.json`,
  sofr30day:      `${API_BASE}/sofr30day.json`,
  sofr90day:      `${API_BASE}/sofr90day.json`,
  sofr1month:     `${API_BASE}/sofr1month.json`,
  sofr3month:     `${API_BASE}/sofr3month.json`,
  sofrSwaps:      `${API_BASE}/AnnualSOFRCompoundSwapRates.json`,
  termSofrSwaps:  `${API_BASE}/1moTermSOFRSwapRates.json`,
  treasuryYield:  `${API_BASE}/yield.json`,
  fedFunds:       `${API_BASE}/federalFundsEffective.json`,
  prime:          `${API_BASE}/usdPrime.json`,
};

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Fetch all API endpoints in parallel using the browser context
    console.log('Fetching Chatham Financial rate data...');
    const results = {};
    for (const [key, url] of Object.entries(ENDPOINTS)) {
      try {
        const response = await page.request.get(url);
        if (response.ok()) {
          results[key] = await response.json();
          console.log(`  ✓ ${key}`);
        } else {
          console.log(`  ✗ ${key}: HTTP ${response.status()}`);
        }
      } catch (e) {
        console.log(`  ✗ ${key}: ${e.message}`);
      }
    }

    // Also take a screenshot of the rates page for reference
    try {
      await page.goto('https://cf.com/rates/us', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: SCREENSHOT_FILE, fullPage: true });
      console.log('  ✓ Screenshot saved');
    } catch (e) {
      console.log('  ⚠ Screenshot skipped:', e.message.substring(0, 80));
    }

    // Build the snapshot from API data
    const snapshot = buildSnapshot(results);

    // Save to history
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      } catch (e) {
        console.warn('⚠ Could not parse existing history file, starting fresh');
        history = [];
      }
    }

    // Replace today's entry if re-running
    const today = snapshot.date;
    history = history.filter(entry => entry.date !== today);
    history.push(snapshot);
    history.sort((a, b) => a.date.localeCompare(b.date));

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    fs.writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2));

    const tenorCount = Object.keys(snapshot.forwardCurve).length +
      Object.keys(snapshot.swapRates).length +
      Object.keys(snapshot.termSOFR).length;
    console.log(`\n✓ Scraped SOFR data for ${today} — ${tenorCount} tenors captured`);
    console.log(`  History file: ${history.length} data points`);

  } catch (error) {
    console.error('✗ Scraper error:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

function buildSnapshot(results) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const snapshot = {
    date: dateStr,
    timestamp: now.toISOString(),
    source: 'Chatham Financial cf.com/rates/us',
    overnightSOFR: null,
    fedFundsRate: null,
    prime: null,
    termSOFR: {},
    swapRates: {},
    forwardCurve: {},
    treasuryYields: {}
  };

  // Overnight SOFR
  if (results.sofr1day) {
    snapshot.overnightSOFR = parseFloat(results.sofr1day.PreviousDay);
    snapshot.forwardCurve['O/N'] = snapshot.overnightSOFR;
  }

  // Fed Funds
  if (results.fedFunds) {
    snapshot.fedFundsRate = parseFloat((parseFloat(results.fedFunds.PreviousDay) * 100).toFixed(3));
  }

  // Prime
  if (results.prime) {
    snapshot.prime = parseFloat((parseFloat(results.prime.PreviousDay) * 100).toFixed(3));
  }

  // Term SOFR fixings (CME Term SOFR)
  // sofr1month = 1M Term SOFR, sofr3month = 3M Term SOFR
  if (results.sofr1month) {
    snapshot.termSOFR['1M'] = parseFloat(results.sofr1month.PreviousDay);
  }
  if (results.sofr3month) {
    snapshot.termSOFR['3M'] = parseFloat(results.sofr3month.PreviousDay);
  }
  // 30-day and 90-day SOFR averages
  if (results.sofr30day) {
    snapshot.termSOFR['30D'] = parseFloat(results.sofr30day.PreviousDay);
  }
  if (results.sofr90day) {
    snapshot.termSOFR['90D'] = parseFloat(results.sofr90day.PreviousDay);
  }

  // SOFR OIS Swap Rates (Annual Compound)
  // API returns: { Rates: [{ LengthInMonths: 12, PreviousDay: "3.705" }, ...] }
  if (results.sofrSwaps && results.sofrSwaps.Rates) {
    for (const r of results.sofrSwaps.Rates) {
      const tenor = monthsToTenor(r.LengthInMonths);
      const rate = parseFloat(r.PreviousDay);
      if (tenor && !isNaN(rate)) {
        snapshot.swapRates[tenor] = rate;
        snapshot.forwardCurve[tenor] = rate;
      }
    }
  }

  // 1M Term SOFR Swap Rates (alternative curve)
  if (results.termSofrSwaps && results.termSofrSwaps.Rates) {
    for (const r of results.termSofrSwaps.Rates) {
      const tenor = monthsToTenor(r.LengthInMonths);
      const rate = parseFloat(r.PreviousDay);
      if (tenor && !isNaN(rate)) {
        // Store as termSofrSwaps for reference; don't overwrite main swapRates
        if (!snapshot.termSofrSwaps) snapshot.termSofrSwaps = {};
        snapshot.termSofrSwaps[tenor] = rate;
      }
    }
  }

  // Treasury Yields
  // API returns: { Rates: [{ Year: "1 Year", PreviousDayYield: "3.672" }, ...] }
  if (results.treasuryYield && results.treasuryYield.Rates) {
    for (const r of results.treasuryYield.Rates) {
      const match = r.Year.match(/(\d+)\s*Year/i);
      if (match) {
        const tenor = match[1] + 'Y';
        const rate = parseFloat(r.PreviousDayYield);
        if (!isNaN(rate)) {
          snapshot.treasuryYields[tenor] = rate;
        }
      }
    }
  }

  // Build forward curve from Term SOFR + swap rates
  if (snapshot.termSOFR['1M']) snapshot.forwardCurve['1M'] = snapshot.termSOFR['1M'];
  if (snapshot.termSOFR['3M']) snapshot.forwardCurve['3M'] = snapshot.termSOFR['3M'];
  if (snapshot.overnightSOFR) snapshot.forwardCurve['O/N'] = snapshot.overnightSOFR;

  return snapshot;
}

function monthsToTenor(months) {
  if (months === 12) return '1Y';
  if (months === 24) return '2Y';
  if (months === 36) return '3Y';
  if (months === 48) return '4Y';
  if (months === 60) return '5Y';
  if (months === 72) return '6Y';
  if (months === 84) return '7Y';
  if (months === 96) return '8Y';
  if (months === 120) return '10Y';
  if (months === 144) return '12Y';
  if (months === 180) return '15Y';
  if (months === 240) return '20Y';
  if (months === 360) return '30Y';
  if (months < 12) return months + 'M';
  return null;
}

main();
