const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');

// Chatham Financial public API endpoints
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

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://cf.com/rates/us',
  'Origin': 'https://cf.com',
};

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Try native fetch first (fast path, works from residential/office IPs)
  let results = await fetchDirect();

  // If blocked (e.g. from datacenter IPs), fall back to Playwright
  if (Object.keys(results).length === 0) {
    console.log('\nDirect fetch blocked — falling back to Playwright browser...');
    results = await fetchWithPlaywright();
  }

  if (Object.keys(results).length === 0) {
    console.error('✗ No data fetched from any source');
    process.exit(1);
  }

  // Build snapshot
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
}

async function fetchDirect() {
  console.log('Fetching Chatham Financial rate data (direct)...');
  const results = {};
  const responses = await Promise.allSettled(
    Object.entries(ENDPOINTS).map(async ([key, url]) => {
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { key, data: await res.json() };
    })
  );
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      results[r.value.key] = r.value.data;
      console.log(`  ✓ ${r.value.key}`);
    } else {
      console.log(`  ✗ ${r.reason?.message || 'unknown error'}`);
    }
  }
  return results;
}

async function fetchWithPlaywright() {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (e) {
    console.log('  Playwright not installed — installing...');
    const { execSync } = require('child_process');
    execSync('npm install playwright', { stdio: 'inherit' });
    execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' });
    chromium = require('playwright').chromium;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Collect API responses intercepted during page load
  const results = {};
  page.on('response', async (response) => {
    const url = response.url();
    for (const [key, endpoint] of Object.entries(ENDPOINTS)) {
      if (url === endpoint || url.startsWith(endpoint)) {
        try {
          results[key] = await response.json();
          console.log(`  ✓ ${key} (intercepted)`);
        } catch (e) { /* not JSON */ }
      }
    }
  });

  try {
    // Visit the rates page — this triggers all the API calls from the browser
    console.log('  Loading rates page in browser...');
    await page.goto('https://cf.com/rates/us', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000); // Let all XHR calls complete

    // If interception didn't catch everything, fetch remaining via browser context
    for (const [key, url] of Object.entries(ENDPOINTS)) {
      if (!results[key]) {
        try {
          const response = await page.request.get(url);
          if (response.ok()) {
            results[key] = await response.json();
            console.log(`  ✓ ${key} (browser fetch)`);
          }
        } catch (e) {
          console.log(`  ✗ ${key}: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return results;
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
    treasuryYields: {},
    termSofrSwaps: {}
  };

  if (results.sofr1day) {
    snapshot.overnightSOFR = parseFloat(results.sofr1day.PreviousDay);
    snapshot.forwardCurve['O/N'] = snapshot.overnightSOFR;
  }
  if (results.fedFunds) {
    snapshot.fedFundsRate = parseFloat((parseFloat(results.fedFunds.PreviousDay) * 100).toFixed(3));
  }
  if (results.prime) {
    snapshot.prime = parseFloat((parseFloat(results.prime.PreviousDay) * 100).toFixed(3));
  }
  if (results.sofr1month) {
    snapshot.termSOFR['1M'] = parseFloat(results.sofr1month.PreviousDay);
  }
  if (results.sofr3month) {
    snapshot.termSOFR['3M'] = parseFloat(results.sofr3month.PreviousDay);
  }
  if (results.sofr30day) {
    snapshot.termSOFR['30D'] = parseFloat(results.sofr30day.PreviousDay);
  }
  if (results.sofr90day) {
    snapshot.termSOFR['90D'] = parseFloat(results.sofr90day.PreviousDay);
  }

  if (results.sofrSwaps?.Rates) {
    for (const r of results.sofrSwaps.Rates) {
      const tenor = monthsToTenor(r.LengthInMonths);
      const rate = parseFloat(r.PreviousDay);
      if (tenor && !isNaN(rate)) {
        snapshot.swapRates[tenor] = rate;
        snapshot.forwardCurve[tenor] = rate;
      }
    }
  }

  if (results.termSofrSwaps?.Rates) {
    for (const r of results.termSofrSwaps.Rates) {
      const tenor = monthsToTenor(r.LengthInMonths);
      const rate = parseFloat(r.PreviousDay);
      if (tenor && !isNaN(rate)) {
        snapshot.termSofrSwaps[tenor] = rate;
      }
    }
  }

  if (results.treasuryYield?.Rates) {
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

  if (snapshot.termSOFR['1M']) snapshot.forwardCurve['1M'] = snapshot.termSOFR['1M'];
  if (snapshot.termSOFR['3M']) snapshot.forwardCurve['3M'] = snapshot.termSOFR['3M'];

  return snapshot;
}

function monthsToTenor(months) {
  if (months % 12 === 0) return (months / 12) + 'Y';
  return months + 'M';
}

main();
