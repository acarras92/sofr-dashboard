const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');
const LATEST_CSV  = path.join(DATA_DIR, 'sofr_latest.csv');

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

// Backup sources for forward SOFR curve
const FRED_API_KEY = process.env.FRED_API_KEY || '';
const FRED_SERIES = {
  SOFR:      'SOFR',        // Overnight SOFR
  SOFR30A:   'SOFR30DAYAVG', // 30-day SOFR average
  SOFR90A:   'SOFR90DAYAVG', // 90-day SOFR average
  SOFR180A:  'SOFR180DAYAVG', // 180-day SOFR average
};
const CME_TERM_SOFR_URL = 'https://www.cmegroup.com/services/sofr-strip-rates';

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

  // If Chatham didn't return swap/forward curve data, try backup sources
  const hasSwaps = Object.keys(snapshot.swapRates).length > 0;
  const hasForward = Object.keys(snapshot.forwardCurve).length > 2; // more than just O/N + 1M
  if (!hasSwaps || !hasForward) {
    console.log('\n⚠ Chatham missing swap/forward data — trying backup sources...');
    await fetchBackupSources(snapshot);
  } else {
    // Even when Chatham works, supplement with backup data for completeness
    await fetchBackupSources(snapshot, true);
  }

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

  // Write flat CSV with Tenor, Rate, Source
  writeLatestCSV(snapshot);

  const tenorCount = Object.keys(snapshot.forwardCurve).length +
    Object.keys(snapshot.swapRates).length +
    Object.keys(snapshot.termSOFR).length;
  console.log(`\n✓ Scraped SOFR data for ${today} — ${tenorCount} tenors captured`);
  console.log(`  History file: ${history.length} data points`);
}

function writeLatestCSV(snapshot) {
  const TENOR_ORDER = ['O/N','30D','90D','1M','3M','6M','9M','12M','18M','1Y','2Y','3Y','4Y','5Y','6Y','7Y','8Y','10Y','12Y','15Y','20Y','30Y'];
  const tenorIdx = t => { const i = TENOR_ORDER.indexOf(t); return i === -1 ? 999 : i; };

  // Collect all tenors with their rate and source
  const rows = [];
  const seen = new Set();

  const add = (tenor, rate, source) => {
    if (seen.has(tenor) || rate == null) return;
    seen.add(tenor);
    rows.push({ tenor, rate, source });
  };

  // Forward curve (primary)
  for (const [t, r] of Object.entries(snapshot.forwardCurve || {})) add(t, r, 'Forward Curve');
  // Swap rates
  for (const [t, r] of Object.entries(snapshot.swapRates || {})) add(t, r, 'SOFR OIS Swap');
  // Term SOFR
  for (const [t, r] of Object.entries(snapshot.termSOFR || {})) add(t, r, 'Term SOFR');
  // Treasury yields
  for (const [t, r] of Object.entries(snapshot.treasuryYields || {})) add(t, r, 'Treasury Yield');
  // Term SOFR swaps
  for (const [t, r] of Object.entries(snapshot.termSofrSwaps || {})) add(t, r, '1M Term SOFR Swap');
  // Top-level rates
  if (snapshot.overnightSOFR != null && !seen.has('O/N')) rows.push({ tenor: 'O/N', rate: snapshot.overnightSOFR, source: 'Overnight SOFR' });
  if (snapshot.fedFundsRate != null) rows.push({ tenor: 'Fed Funds', rate: snapshot.fedFundsRate, source: 'Fed Funds Effective' });
  if (snapshot.prime != null) rows.push({ tenor: 'Prime', rate: snapshot.prime, source: 'USD Prime' });

  rows.sort((a, b) => tenorIdx(a.tenor) - tenorIdx(b.tenor));

  let csv = 'Tenor,Rate,Source\n';
  for (const r of rows) {
    csv += `${r.tenor},${r.rate},${r.source}\n`;
  }

  fs.writeFileSync(LATEST_CSV, csv);
  console.log(`  CSV written: ${rows.length} rows → data/sofr_latest.csv`);
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

async function fetchBackupSources(snapshot, supplementOnly = false) {
  const backupResults = await Promise.allSettled([
    fetchFRED(snapshot, supplementOnly),
    fetchCMETermSOFR(snapshot, supplementOnly),
  ]);
  for (const r of backupResults) {
    if (r.status === 'rejected') {
      console.log(`  ⚠ Backup source error: ${r.reason?.message || 'unknown'}`);
    }
  }
}

async function fetchFRED(snapshot, supplementOnly) {
  if (!FRED_API_KEY) {
    console.log('  ⊘ FRED: No API key set (FRED_API_KEY) — skipping');
    return;
  }
  console.log('  Fetching FRED SOFR data...');
  for (const [label, seriesId] of Object.entries(FRED_SERIES)) {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=5`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const obs = data.observations?.find(o => o.value !== '.');
      if (obs) {
        const rate = parseFloat(obs.value);
        if (!isNaN(rate)) {
          // Map FRED series to our snapshot fields
          if (seriesId === 'SOFR') {
            if (!snapshot.overnightSOFR || !supplementOnly) {
              snapshot.overnightSOFR = snapshot.overnightSOFR || rate;
              snapshot.backupSOFR = snapshot.backupSOFR || {};
              snapshot.backupSOFR.overnightSOFR = rate;
              snapshot.backupSOFR.overnightSOFR_date = obs.date;
              console.log(`    ✓ FRED ${seriesId}: ${rate}% (${obs.date})`);
            }
          } else if (seriesId === 'SOFR30DAYAVG') {
            snapshot.backupSOFR = snapshot.backupSOFR || {};
            snapshot.backupSOFR.sofr30DayAvg = rate;
            if (!snapshot.termSOFR['30D'] || !supplementOnly) {
              snapshot.termSOFR['30D'] = snapshot.termSOFR['30D'] || rate;
            }
            console.log(`    ✓ FRED ${seriesId}: ${rate}% (${obs.date})`);
          } else if (seriesId === 'SOFR90DAYAVG') {
            snapshot.backupSOFR = snapshot.backupSOFR || {};
            snapshot.backupSOFR.sofr90DayAvg = rate;
            if (!snapshot.termSOFR['90D'] || !supplementOnly) {
              snapshot.termSOFR['90D'] = snapshot.termSOFR['90D'] || rate;
            }
            console.log(`    ✓ FRED ${seriesId}: ${rate}% (${obs.date})`);
          } else if (seriesId === 'SOFR180DAYAVG') {
            snapshot.backupSOFR = snapshot.backupSOFR || {};
            snapshot.backupSOFR.sofr180DayAvg = rate;
            console.log(`    ✓ FRED ${seriesId}: ${rate}% (${obs.date})`);
          }
        }
      }
    } catch (e) { /* skip this series */ }
  }
}

async function fetchCMETermSOFR(snapshot, supplementOnly) {
  console.log('  Fetching CME Term SOFR...');
  try {
    // CME publishes Term SOFR strip rates
    const res = await fetch(CME_TERM_SOFR_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });
    if (!res.ok) {
      // Try the HTML page as fallback for Term SOFR
      const pageRes = await fetch('https://www.cmegroup.com/market-data/cme-group-benchmark-administration/term-sofr.html', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        // Extract rates from HTML using regex patterns
        const ratePattern = /(\d+)\s*(?:Month|Mo)\s*Term\s*SOFR[^]*?(\d+\.\d+)/gi;
        let match;
        const cmeRates = {};
        while ((match = ratePattern.exec(html)) !== null) {
          const months = parseInt(match[1]);
          const rate = parseFloat(match[2]);
          if (!isNaN(rate) && rate > 0 && rate < 20) {
            cmeRates[months + 'M'] = rate;
          }
        }
        if (Object.keys(cmeRates).length > 0) {
          snapshot.backupSOFR = snapshot.backupSOFR || {};
          snapshot.backupSOFR.cmeTermSOFR = cmeRates;
          console.log(`    ✓ CME Term SOFR (HTML): ${JSON.stringify(cmeRates)}`);
          // Fill in missing termSOFR values
          for (const [tenor, rate] of Object.entries(cmeRates)) {
            if (!snapshot.termSOFR[tenor] || !supplementOnly) {
              snapshot.termSOFR[tenor] = snapshot.termSOFR[tenor] || rate;
            }
          }
        } else {
          console.log('    ⊘ CME Term SOFR: Could not parse rates from HTML');
        }
      } else {
        console.log(`    ⊘ CME Term SOFR: HTTP ${res.status} — skipping`);
      }
      return;
    }
    const data = await res.json();
    snapshot.backupSOFR = snapshot.backupSOFR || {};
    console.log(`    ✓ CME Term SOFR API`);

    // Parse CME strip data — contains Term SOFR fixings + forward curve
    const latestStrip = data.resultsStrip?.[0];
    const latestCurve = data.resultsCurve?.[0];

    // Term SOFR fixings (1M, 3M, 6M, 1Y)
    if (latestStrip?.rates?.sofrRatesFixing) {
      const cmeFixings = {};
      for (const fix of latestStrip.rates.sofrRatesFixing) {
        const rate = parseFloat(fix.price);
        if (fix.term && !isNaN(rate)) {
          cmeFixings[fix.term] = rate;
          if (!supplementOnly || !snapshot.termSOFR[fix.term]) {
            snapshot.termSOFR[fix.term] = snapshot.termSOFR[fix.term] || rate;
          }
          // Add 6M and 1Y to forward curve if missing
          if (fix.term === '6M' || fix.term === '1Y') {
            snapshot.forwardCurve[fix.term] = snapshot.forwardCurve[fix.term] || rate;
          }
        }
      }
      snapshot.backupSOFR.cmeTermSOFRFixings = cmeFixings;
      console.log(`    ✓ CME fixings: ${Object.entries(cmeFixings).map(([k,v]) => `${k}=${v}%`).join(', ')}`);
    }

    // SOFR averages from strip
    if (latestStrip) {
      if (latestStrip.average30day) {
        snapshot.backupSOFR.cme30DayAvg = latestStrip.average30day;
      }
      if (latestStrip.average90day) {
        snapshot.backupSOFR.cme90DayAvg = latestStrip.average90day;
      }
      if (latestStrip.average180day) {
        snapshot.backupSOFR.cme180DayAvg = latestStrip.average180day;
      }
    }

    // SOFR OIS swap curve (1Y-30Y) — the actual forward curve
    if (latestCurve?.rates?.sofrRates) {
      const cmeCurve = {};
      for (const pt of latestCurve.rates.sofrRates) {
        const rate = parseFloat(pt.price);
        if (pt.term && !isNaN(rate)) {
          cmeCurve[pt.term] = rate;
          if (!supplementOnly || !snapshot.forwardCurve[pt.term]) {
            snapshot.forwardCurve[pt.term] = snapshot.forwardCurve[pt.term] || rate;
          }
          if (!supplementOnly || !snapshot.swapRates[pt.term]) {
            snapshot.swapRates[pt.term] = snapshot.swapRates[pt.term] || rate;
          }
        }
      }
      snapshot.backupSOFR.cmeSofrCurve = cmeCurve;
      console.log(`    ✓ CME SOFR curve: ${Object.entries(cmeCurve).map(([k,v]) => `${k}=${v}%`).join(', ')}`);
    }

    // SOFR-Fed Funds basis
    if (latestCurve?.rates?.sofrFedFundRates) {
      const basis = {};
      for (const pt of latestCurve.rates.sofrFedFundRates) {
        basis[pt.term] = parseFloat(pt.price);
      }
      snapshot.backupSOFR.cmeSofrFedFundBasis = basis;
    }
  } catch (e) {
    console.log(`    ⊘ CME Term SOFR: ${e.message}`);
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
