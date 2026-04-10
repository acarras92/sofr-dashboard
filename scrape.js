const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');
const SCREENSHOT_FILE = path.join(DATA_DIR, 'latest_screenshot.png');

async function main() {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Collect intercepted API data
  const apiData = {};
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('rate') || url.includes('sofr') || url.includes('curve') || url.includes('swap') || url.includes('forward') || url.includes('market')) {
      try {
        const json = await response.json();
        console.log('Found API endpoint:', url);
        console.log('Data sample:', JSON.stringify(json).substring(0, 500));
        apiData[url] = json;
      } catch (e) { /* not JSON, skip */ }
    }
  });

  try {
    // Step 1: Log in to Chatham Financial
    const email = process.env.CHATHAM_EMAIL;
    const password = process.env.CHATHAM_PASSWORD;

    if (!email || !password) {
      console.warn('⚠ CHATHAM_EMAIL or CHATHAM_PASSWORD not set — attempting without login');
    } else {
      console.log('Logging in to Chatham Financial...');
      await page.goto('https://cf.com/login', { waitUntil: 'networkidle', timeout: 30000 });
      await page.screenshot({ path: path.join(DATA_DIR, 'login_page.png') });

      // Try multiple possible selectors for email/password fields
      const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[name="username"]', '#email', '#username'];
      const passwordSelectors = ['input[type="password"]', 'input[name="password"]', '#password'];

      let emailFilled = false;
      for (const sel of emailSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.fill(email);
            emailFilled = true;
            console.log(`  Email filled using selector: ${sel}`);
            break;
          }
        } catch (e) { /* try next */ }
      }

      let passwordFilled = false;
      for (const sel of passwordSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.fill(password);
            passwordFilled = true;
            console.log(`  Password filled using selector: ${sel}`);
            break;
          }
        } catch (e) { /* try next */ }
      }

      if (emailFilled && passwordFilled) {
        // Click submit
        const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")'];
        for (const sel of submitSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn) {
              await btn.click();
              console.log(`  Submitted using selector: ${sel}`);
              break;
            }
          } catch (e) { /* try next */ }
        }
        // Wait for navigation after login
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
        } catch (e) {
          console.log('  Navigation after login timed out — continuing anyway');
        }
        await page.screenshot({ path: path.join(DATA_DIR, 'post_login.png') });
        console.log('✓ Login attempted');
      } else {
        console.warn('⚠ Could not find login form fields — continuing without login');
      }
    }

    // Step 2: Navigate to rates page
    console.log('Navigating to rates page...');
    await page.goto('https://www.chathamfinancial.com/technology/us-market-rates', {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Wait for rate tables to render (React app)
    try {
      await page.waitForSelector('table, [class*="rate"], [class*="table"], [class*="grid"]', { timeout: 20000 });
      console.log('✓ Rate content detected');
    } catch (e) {
      console.log('⚠ No table/rate elements found — page may require auth or different structure');
    }

    // Give React extra time to hydrate
    await page.waitForTimeout(3000);
    await page.screenshot({ path: SCREENSHOT_FILE, fullPage: true });
    console.log('✓ Screenshot saved');

    // Step 3: Log all network requests for debugging
    console.log('\n--- All intercepted API endpoints ---');
    for (const [url, data] of Object.entries(apiData)) {
      console.log(`  ${url}`);
    }
    console.log('---\n');

    // Step 4: Scrape rate data from the page
    const scrapedData = await page.evaluate(() => {
      const result = {
        termSOFR: {},
        swapRates: {},
        forwardCurve: {},
        rawTables: []
      };

      // Grab all tables on the page
      const tables = document.querySelectorAll('table');
      tables.forEach((table, idx) => {
        const headerRow = table.querySelector('thead tr, tr:first-child');
        const headerText = headerRow ? headerRow.textContent.trim() : '';
        const rows = [];
        table.querySelectorAll('tbody tr, tr').forEach(tr => {
          const cells = [];
          tr.querySelectorAll('td, th').forEach(td => {
            cells.push(td.textContent.trim());
          });
          if (cells.length > 0) rows.push(cells);
        });
        result.rawTables.push({ index: idx, header: headerText, rows });
      });

      // Also grab any rate-like elements outside tables
      const allText = document.body.innerText;

      // Look for patterns like "1M SOFR: 4.82%" or "1 Month: 4.82"
      const ratePatterns = allText.match(/(\d+[MY]\s*(?:Term\s*)?SOFR|(?:Term\s+)?SOFR\s*\d+[MY])\s*[:\s]+(\d+\.\d+)/gi);
      if (ratePatterns) {
        result.ratePatterns = ratePatterns;
      }

      // Look for swap rate patterns
      const swapPatterns = allText.match(/(\d+[Y]\s*(?:Swap|OIS))\s*[:\s]+(\d+\.\d+)/gi);
      if (swapPatterns) {
        result.swapPatterns = swapPatterns;
      }

      return result;
    });

    console.log('Raw tables found:', scrapedData.rawTables.length);
    scrapedData.rawTables.forEach(t => {
      console.log(`  Table ${t.index}: "${t.header.substring(0, 80)}" — ${t.rows.length} rows`);
      t.rows.slice(0, 3).forEach(r => console.log(`    ${JSON.stringify(r)}`));
    });

    if (scrapedData.ratePatterns) {
      console.log('Rate patterns found:', scrapedData.ratePatterns);
    }

    // Step 5: Parse scraped data into structured format
    const snapshot = parseRateData(scrapedData, apiData);

    // Step 6: Save to history
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      } catch (e) {
        console.warn('⚠ Could not parse existing history file, starting fresh');
        history = [];
      }
    }

    // Remove existing entry for today if re-running
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
    // Take error screenshot
    try {
      await page.screenshot({ path: path.join(DATA_DIR, 'error_screenshot.png'), fullPage: true });
    } catch (e) { /* ignore */ }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

function parseRateData(scrapedData, apiData) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const snapshot = {
    date: dateStr,
    timestamp: now.toISOString(),
    source: 'Chatham Financial cf.com/rates/us',
    termSOFR: {},
    swapRates: {},
    forwardCurve: {}
  };

  // Try to parse from API data first (most reliable)
  for (const [url, data] of Object.entries(apiData)) {
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (item.tenor && item.rate != null) {
          categorizeRate(snapshot, item.tenor, parseFloat(item.rate));
        }
      });
    } else if (typeof data === 'object' && data !== null) {
      // Try common API response shapes
      const possibleArrays = ['rates', 'data', 'results', 'items', 'curve', 'forwardCurve', 'swapRates'];
      for (const key of possibleArrays) {
        if (Array.isArray(data[key])) {
          data[key].forEach(item => {
            const tenor = item.tenor || item.term || item.maturity || item.label;
            const rate = item.rate || item.value || item.mid;
            if (tenor && rate != null) {
              categorizeRate(snapshot, String(tenor), parseFloat(rate));
            }
          });
        }
      }
      // Also check if it's a flat object like { "1M": 4.82, "3M": 4.85 }
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'number' && /^\d+[MY]$/.test(key)) {
          categorizeRate(snapshot, key, val);
        }
      }
    }
  }

  // Then try to parse from scraped tables
  for (const table of scrapedData.rawTables) {
    for (const row of table.rows) {
      if (row.length >= 2) {
        const tenorCell = row[0];
        // Look for rate values in remaining cells
        for (let i = 1; i < row.length; i++) {
          const rateStr = row[i].replace(/[%,]/g, '').trim();
          const rate = parseFloat(rateStr);
          if (!isNaN(rate) && rate > 0 && rate < 20) {
            // Normalize tenor
            const tenor = normalizeTenor(tenorCell);
            if (tenor) {
              categorizeRate(snapshot, tenor, rate);
              break; // Take first rate value
            }
          }
        }
      }
    }
  }

  return snapshot;
}

function normalizeTenor(raw) {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();

  // Already normalized
  if (/^\d+[MY]$/.test(s)) return s;

  // "1 Month" -> "1M", "3 Year" -> "3Y"
  const monthMatch = s.match(/(\d+)\s*(?:MONTH|MO|MTH)/i);
  if (monthMatch) return monthMatch[1] + 'M';

  const yearMatch = s.match(/(\d+)\s*(?:YEAR|YR)/i);
  if (yearMatch) return yearMatch[1] + 'Y';

  // "Overnight", "O/N"
  if (/overnight|o\/n/i.test(s)) return '0M';

  return null;
}

function categorizeRate(snapshot, tenor, rate) {
  // Term SOFR: short-end fixings (1M, 3M, 6M, 12M)
  const termSOFRTenors = ['1M', '3M', '6M', '12M'];
  // Swap rates: annual tenors
  const swapTenors = ['1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'];

  if (termSOFRTenors.includes(tenor)) {
    snapshot.termSOFR[tenor] = rate;
  }
  if (swapTenors.includes(tenor)) {
    snapshot.swapRates[tenor] = rate;
  }
  // Everything goes into forward curve
  snapshot.forwardCurve[tenor] = rate;
}

main();
