const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');

// Chatham Financial public API endpoints (no auth required)
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

  console.log('Fetching Chatham Financial rate data...');

  // Fetch all endpoints in parallel
  const entries = Object.entries(ENDPOINTS);
  const responses = await Promise.allSettled(
    entries.map(async ([key, url]) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return { key, data: json };
    })
  );

  const results = {};
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      results[r.value.key] = r.value.data;
      console.log(`  ✓ ${r.value.key}`);
    } else {
      console.log(`  ✗ ${r.reason?.message || 'unknown error'}`);
    }
  }

  if (Object.keys(results).length === 0) {
    console.error('✗ No data fetched from any endpoint');
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

  // Term SOFR fixings
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

  // SOFR OIS Swap Rates (Annual Compound)
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

  // 1M Term SOFR Swap Rates
  if (results.termSofrSwaps?.Rates) {
    for (const r of results.termSofrSwaps.Rates) {
      const tenor = monthsToTenor(r.LengthInMonths);
      const rate = parseFloat(r.PreviousDay);
      if (tenor && !isNaN(rate)) {
        snapshot.termSofrSwaps[tenor] = rate;
      }
    }
  }

  // Treasury Yields
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

  // Add Term SOFR to forward curve
  if (snapshot.termSOFR['1M']) snapshot.forwardCurve['1M'] = snapshot.termSOFR['1M'];
  if (snapshot.termSOFR['3M']) snapshot.forwardCurve['3M'] = snapshot.termSOFR['3M'];

  return snapshot;
}

function monthsToTenor(months) {
  if (months % 12 === 0) return (months / 12) + 'Y';
  return months + 'M';
}

main();
