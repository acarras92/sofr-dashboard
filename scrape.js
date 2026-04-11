const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sofr_history.json');
const LATEST_FILE = path.join(DATA_DIR, 'sofr_latest.json');
const LATEST_CSV  = path.join(DATA_DIR, 'sofr_latest.csv');
const RAW_XLSX    = path.join(DATA_DIR, 'chatham_raw.xlsx');

const CME_TERM_SOFR_URL = 'https://www.cmegroup.com/services/sofr-strip-rates';

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let snapshot = null;

  // Primary: download Excel from Chatham after login
  try {
    snapshot = await downloadChathamExcel();
  } catch (err) {
    console.error(`⚠ Chatham Excel download failed: ${err.message}`);
  }

  // Fallback: CME SOFR strip rates
  if (!snapshot || snapshot.forwardCurve.length === 0) {
    console.log('\n⚠ Chatham data unavailable — falling back to CME...');
    snapshot = await fetchCMEFallback();
  }

  if (!snapshot || snapshot.forwardCurve.length === 0) {
    console.error('✗ No forward curve data from any source');
    process.exit(1);
  }

  // Save to history
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠ Could not parse existing history, starting fresh');
      history = [];
    }
  }

  const today = snapshot.date;
  history = history.filter(entry => entry.date !== today);
  history.push(snapshot);
  history.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  fs.writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2));

  // Write CSV: Date,Year,SOFR
  let csv = 'Date,Year,SOFR\n';
  for (const pt of snapshot.forwardCurve) {
    csv += `${pt.date},${pt.year},${pt.sofr}\n`;
  }
  fs.writeFileSync(LATEST_CSV, csv);

  console.log(`\n✓ Scraped SOFR forward curve for ${today} — ${snapshot.forwardCurve.length} monthly points`);
  console.log(`  History file: ${history.length} snapshots`);
  console.log(`  CSV written → data/sofr_latest.csv`);

  // Show first 5 rows
  console.log('\n  First 5 rows:');
  for (const pt of snapshot.forwardCurve.slice(0, 5)) {
    console.log(`    ${pt.date}  ${pt.year}  ${pt.sofr}%`);
  }
}

// ─── Primary: Chatham Excel download ────────────────────────────────────────

async function downloadChathamExcel() {
  const { chromium } = require('playwright');

  const email = process.env.CHATHAM_EMAIL;
  const password = process.env.CHATHAM_PASSWORD;
  if (!email || !password) {
    throw new Error('CHATHAM_EMAIL / CHATHAM_PASSWORD not set');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // Step 1: Log in — go to homepage first, then click Login button in nav
    console.log('Logging in to Chatham Financial...');
    await page.goto('https://cf.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banner if present
    try {
      const cookieBtn = await page.$('button:has-text("Accept All"), button:has-text("Accept")');
      if (cookieBtn && await cookieBtn.isVisible()) {
        await cookieBtn.click();
        console.log('  Dismissed cookie banner');
        await page.waitForTimeout(1000);
      }
    } catch (e) { /* no cookie banner */ }

    // Click the Login button in the navigation bar
    const loginNavBtn = await page.$('a:has-text("Login"), button:has-text("Login"), a[href*="/auth/login"]');
    if (loginNavBtn && await loginNavBtn.isVisible()) {
      console.log('  Clicking nav Login button...');
      await loginNavBtn.click();
      await page.waitForTimeout(4000);
    } else {
      console.log('  No Login button found — trying direct auth URLs...');
      await page.goto('https://cf.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: path.join(DATA_DIR, 'step1_login_page.png') });
    console.log(`  Auth page URL: ${page.url()}`);

    // The nav "Login" button may land on a signup page.
    // Look for "Already a client? Log in" or "Already have an account? Log in" link
    const alreadyLink = await page.$('a:has-text("Log in"), a:has-text("Log In"), a:has-text("Sign in")');
    if (alreadyLink && await alreadyLink.isVisible()) {
      const linkText = (await alreadyLink.textContent() || '').trim();
      // Only click if the page is a signup/register form, not already a login form
      const pageText = await page.textContent('body');
      if (pageText.includes('Create an account') || pageText.includes('Set Password') || pageText.includes('Sign up') || page.url().includes('signup')) {
        console.log(`  On signup page — clicking "${linkText}" to switch to login...`);
        await alreadyLink.click();
        await page.waitForTimeout(4000);
        await page.screenshot({ path: path.join(DATA_DIR, 'step1b_switched_to_login.png') });
        console.log(`  Now at: ${page.url()}`);
      }
    }

    // Wait for email input to appear
    try {
      await page.waitForSelector('input[type="email"], input[type="text"], input[name="email"], input[name="username"], input[name="loginfmt"]', { timeout: 10000 });
    } catch (e) {
      console.log('  No email input appeared — taking debug screenshot');
      await page.screenshot({ path: path.join(DATA_DIR, 'step1c_no_inputs.png'), fullPage: true });
      const allInputs = await page.$$eval('input', els => els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, visible: e.offsetParent !== null })));
      console.log('  All inputs on page:', JSON.stringify(allInputs));
      console.log(`  Current URL: ${page.url()}`);
    }

    // Fill email — try many selector patterns including Microsoft SSO (loginfmt)
    const emailSels = [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
      'input[name="loginfmt"]', // Microsoft SSO
      '#email', '#username', '#i0116', // Microsoft SSO ID
      'input[autocomplete="email"]', 'input[autocomplete="username"]',
      'input[placeholder*="email" i]', 'input[placeholder*="user" i]',
    ];
    let filled = false;
    for (const sel of emailSels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(email);
          console.log(`  Email filled: ${sel}`);
          filled = true;
          break;
        }
      } catch (e) { /* try next */ }
    }
    if (!filled) {
      // Broadest fallback: first visible text/email input
      const inputs = await page.$$('input');
      for (const inp of inputs) {
        try {
          if (!(await inp.isVisible())) continue;
          const type = await inp.getAttribute('type') || 'text';
          if (['text', 'email'].includes(type)) {
            await inp.fill(email);
            console.log('  Email filled via first visible text input');
            filled = true;
            break;
          }
        } catch (e) { /* skip */ }
      }
    }
    if (!filled) throw new Error('Could not find email input');

    // Some SSO flows have a "Next" button before the password field
    const nextBtn = await page.$('button:has-text("Next"), input[type="submit"][value*="Next"], #idSIButton9');
    if (nextBtn && await nextBtn.isVisible()) {
      console.log('  Clicking Next (SSO flow)...');
      await nextBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(DATA_DIR, 'step1c_after_next.png') });
    }

    // Fill password
    const pwSels = ['input[type="password"]', 'input[name="password"]', 'input[name="passwd"]', '#password', '#i0118', '#passwordInput'];
    let pwFilled = false;
    // Wait for password field to appear
    try {
      await page.waitForSelector(pwSels.join(', '), { timeout: 8000 });
    } catch (e) { /* may already be visible */ }
    for (const sel of pwSels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(password);
          console.log(`  Password filled: ${sel}`);
          pwFilled = true;
          break;
        }
      } catch (e) { /* try next */ }
    }
    if (!pwFilled) throw new Error('Could not find password input');

    // Submit
    const submitSels = [
      'button[type="submit"]', 'input[type="submit"]',
      '#idSIButton9', // Microsoft SSO
      'button:has-text("Log in")', 'button:has-text("Sign in")',
      'button:has-text("Login")', 'button:has-text("Submit")',
    ];
    for (const sel of submitSels) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          console.log(`  Submitted: ${sel}`);
          break;
        }
      } catch (e) { /* try next */ }
    }

    // Wait for login to complete — watch for URL change away from login/auth pages
    try {
      await page.waitForURL(url => {
        const u = url.toString().toLowerCase();
        return !u.includes('/login') && !u.includes('/auth') && !u.includes('microsoftonline') && !u.includes('/signin');
      }, { timeout: 25000 });
    } catch (e) {
      console.log('  Login navigation wait timed out — continuing...');
    }

    // Handle "Stay signed in?" prompt (Microsoft SSO)
    try {
      const stayBtn = await page.$('button:has-text("Yes"), #idSIButton9, button:has-text("Stay signed in")');
      if (stayBtn && await stayBtn.isVisible()) {
        await stayBtn.click();
        console.log('  Clicked "Stay signed in"');
        await page.waitForTimeout(3000);
      }
    } catch (e) { /* no prompt */ }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(DATA_DIR, 'step2_post_login.png') });
    console.log(`✓ Login complete — URL: ${page.url()}`);

    // Step 2: Navigate to rates page
    console.log('Navigating to rates page...');
    await page.goto('https://cf.com/rates/us', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(DATA_DIR, 'step3_rates_page.png') });
    console.log('✓ Rates page loaded');

    // Step 3: Scroll down to find SOFR Forward Curve section and its download button
    // The rates page is a summary — the forward curve and download may be further down
    // or on a detail "View" page. First scroll to capture all sections visible.
    console.log('Scrolling to find forward curve section...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(DATA_DIR, 'step3b_scrolled_bottom.png'), fullPage: true });

    // Log all section headings and "View" links on the page
    const sections = await page.$$eval('h2, h3, [class*="heading"], [class*="title"]', els =>
      els.map(e => e.textContent.trim()).filter(t => t.length > 0 && t.length < 100)
    );
    console.log('  Page sections:', sections.join(' | '));

    const viewLinks = await page.$$eval('a[href*="/rates/"]', els =>
      els.map(e => ({ text: e.textContent.trim(), href: e.getAttribute('href') }))
    );
    console.log('  View links:');
    for (const vl of viewLinks) console.log(`    "${vl.text}" → ${vl.href}`);

    // Navigate to the SOFR forward curve detail page
    // Look for a link that mentions "forward", "sofr", or "curve"
    let targetHref = null;
    for (const vl of viewLinks) {
      const combined = `${vl.text} ${vl.href}`.toLowerCase();
      if (combined.includes('forward') || combined.includes('sofr-forward') ||
          combined.includes('curve') || combined.includes('sofr-swap')) {
        targetHref = vl.href;
        console.log(`  Found forward curve link: ${vl.href}`);
        break;
      }
    }

    // If no forward curve link, try SOFR-related links
    if (!targetHref) {
      for (const vl of viewLinks) {
        const combined = `${vl.text} ${vl.href}`.toLowerCase();
        if (combined.includes('sofr') && !combined.includes('treasury')) {
          targetHref = vl.href;
          console.log(`  Using SOFR link: ${vl.href}`);
          break;
        }
      }
    }

    if (targetHref) {
      // Navigate to the detail page
      const fullUrl = targetHref.startsWith('http') ? targetHref : `https://cf.com${targetHref}`;
      console.log(`  Navigating to: ${fullUrl}`);
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(DATA_DIR, 'step3c_detail_page.png'), fullPage: true });

      // Log page title and URL
      console.log(`  Detail page: ${page.url()}`);
      const detailSections = await page.$$eval('h1, h2, h3', els =>
        els.map(e => e.textContent.trim()).filter(t => t.length > 0)
      );
      console.log(`  Headings: ${detailSections.join(' | ')}`);
    }

    // Now search for download button on this page (detail or summary)
    console.log('Looking for download/export button...');
    const downloadSelectors = [
      'button[aria-label*="download" i]',
      'button[aria-label*="export" i]',
      'button[aria-label*="Download" i]',
      'a[href*=".xlsx"]',
      'a[href*=".xls"]',
      'a[href*="download"]',
      'a[href*="export"]',
      'button:has-text("Download")',
      'button:has-text("Export")',
      'a:has-text("Download")',
      'a:has-text("Export")',
      '[data-testid*="download" i]',
      '[data-testid*="export" i]',
    ];

    let downloadBtn = null;
    for (const sel of downloadSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (await el.isVisible()) {
            const text = (await el.textContent() || '').toLowerCase();
            const ariaLabel = (await el.getAttribute('aria-label') || '').toLowerCase();
            downloadBtn = el;
            console.log(`  Found download button: ${sel} — text="${text.trim().substring(0, 40)}" aria="${ariaLabel}"`);
            break;
          }
        }
      } catch (e) { /* selector not found */ }
      if (downloadBtn) break;
    }

    // Broader search: any button/link with download/export in text, aria, title, or class
    if (!downloadBtn) {
      console.log('  Broader search for download elements...');
      const allEls = await page.$$('button, a, [role="button"]');
      for (const el of allEls) {
        try {
          if (!(await el.isVisible())) continue;
          const text = (await el.textContent() || '').toLowerCase();
          const href = (await el.getAttribute('href') || '').toLowerCase();
          const ariaLabel = (await el.getAttribute('aria-label') || '').toLowerCase();
          const title = (await el.getAttribute('title') || '').toLowerCase();
          const cls = (await el.getAttribute('class') || '').toLowerCase();
          const all = `${text} ${href} ${ariaLabel} ${title} ${cls}`;
          if (all.includes('download') || all.includes('export') || all.includes('.xlsx')) {
            downloadBtn = el;
            console.log(`  Found via broad search: text="${text.trim().substring(0, 40)}" aria="${ariaLabel}" href="${href.substring(0, 60)}"`);
            break;
          }
        } catch (e) { /* skip */ }
      }
    }

    if (!downloadBtn) {
      // Dump all buttons for debugging
      console.log('  No download button found. All visible interactive elements:');
      const btns = await page.$$('button, a');
      for (const btn of btns) {
        try {
          if (!(await btn.isVisible())) continue;
          const text = (await btn.textContent() || '').trim().substring(0, 60);
          const ariaLabel = await btn.getAttribute('aria-label') || '';
          const href = await btn.getAttribute('href') || '';
          const cls = (await btn.getAttribute('class') || '').substring(0, 40);
          if (text || ariaLabel || href) {
            console.log(`    [${await btn.evaluate(e => e.tagName)}] text="${text}" aria="${ariaLabel}" href="${href.substring(0, 60)}" class="${cls}"`);
          }
        } catch (e) { /* skip */ }
      }
      await page.screenshot({ path: path.join(DATA_DIR, 'step4_no_download_btn.png'), fullPage: true });
      throw new Error('Download button not found on page');
    }

    await page.screenshot({ path: path.join(DATA_DIR, 'step4_before_download.png') });

    // Step 4: Click and capture the download
    console.log('Clicking download button...');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      downloadBtn.click(),
    ]);

    const suggestedName = download.suggestedFilename();
    console.log(`  Download started: ${suggestedName}`);

    await download.saveAs(RAW_XLSX);
    console.log(`  Saved to: data/chatham_raw.xlsx`);
    await page.screenshot({ path: path.join(DATA_DIR, 'step5_after_download.png') });

    // Step 5: Parse the Excel file
    const snapshot = parseChathamExcel(RAW_XLSX);
    return snapshot;

  } finally {
    await browser.close();
  }
}

// ─── Excel parser ───────────────────────────────────────────────────────────

function parseChathamExcel(filePath) {
  console.log('\nParsing Excel file...');
  const workbook = XLSX.readFile(filePath);

  // Find the sheet with the forward curve
  let curveSheet = null;
  let curveSheetName = null;

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Look for header row containing "Date", "Year", "SOFR" or "OUTPUT"
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const row = (data[i] || []).map(c => String(c || '').toLowerCase());
      const joined = row.join(' ');
      if ((joined.includes('sofr') || joined.includes('output')) &&
          (joined.includes('date') || joined.includes('year') || joined.includes('month'))) {
        curveSheet = data;
        curveSheetName = name;
        console.log(`  Found curve data in sheet "${name}" (header row ${i})`);
        break;
      }
    }
    if (curveSheet) break;
  }

  // If no matching header, try the first sheet with enough rows
  if (!curveSheet) {
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (data.length > 20) {
        curveSheet = data;
        curveSheetName = name;
        console.log(`  Using sheet "${name}" (${data.length} rows, no header match)`);
        break;
      }
    }
  }

  if (!curveSheet) {
    // Dump all sheet names and first rows for debugging
    console.log('  Available sheets:');
    for (const name of workbook.SheetNames) {
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
      console.log(`    "${name}": ${data.length} rows`);
      if (data.length > 0) console.log(`      Row 0: ${JSON.stringify(data[0])}`);
      if (data.length > 1) console.log(`      Row 1: ${JSON.stringify(data[1])}`);
    }
    throw new Error('Could not find forward curve sheet in Excel');
  }

  // Find column indices — scan ALL columns since data may not start at column A
  let headerRowIdx = -1;
  let dateCol = -1, yearCol = -1, sofrCol = -1, outputCol = -1;

  for (let i = 0; i < Math.min(curveSheet.length, 15); i++) {
    const row = curveSheet[i] || [];
    for (let j = 0; j < row.length; j++) {
      if (row[j] == null) continue;
      const val = String(row[j]).toLowerCase().trim();
      if (val === 'date' || val === 'month' || val === 'period') { dateCol = j; headerRowIdx = i; }
      if (val === 'year') yearCol = j;
      if (val === 'sofr' || val === 'rate' || val === 'sofr rate' || val.includes('term sofr') || val.includes('1-month term sofr')) sofrCol = j;
      if (val === 'output' || val.includes('output')) outputCol = j;
    }
    if (dateCol >= 0) break; // found the header row
  }

  // Use OUTPUT column if SOFR column not found; fall back to column after Date
  if (sofrCol < 0 && outputCol >= 0) sofrCol = outputCol;
  if (sofrCol < 0 && dateCol >= 0) {
    // SOFR is likely the column right after Date (or after Year if present)
    sofrCol = yearCol >= 0 ? yearCol + 1 : dateCol + 1;
    console.log(`  SOFR column not labeled — using column ${sofrCol} (next after date/year)`);
  }

  // If still no header, scan for first row with an Excel serial date + small decimal
  if (headerRowIdx < 0) {
    console.log('  No header row found — scanning for date+rate pattern...');
    for (let i = 0; i < Math.min(curveSheet.length, 20); i++) {
      const row = curveSheet[i] || [];
      for (let j = 0; j < row.length; j++) {
        if (typeof row[j] === 'number' && row[j] > 40000 && row[j] < 60000) {
          // Looks like an Excel date serial
          dateCol = j;
          sofrCol = j + 1; // rate should be right next to it
          headerRowIdx = i - 1; // data starts at this row
          console.log(`  Found date serial at row ${i}, col ${j}`);
          break;
        }
      }
      if (dateCol >= 0) break;
    }
  }

  if (headerRowIdx < 0) {
    headerRowIdx = 0;
    dateCol = 0;
    yearCol = 1;
    sofrCol = 2;
    console.log('  Falling back to columns 0=Date, 1=Year, 2=SOFR');
  }

  console.log(`  Columns: Date=${dateCol}, Year=${yearCol >= 0 ? yearCol : 'auto'}, SOFR=${sofrCol}, header row=${headerRowIdx}`);

  // Parse data rows
  const forwardCurve = [];
  for (let i = headerRowIdx + 1; i < curveSheet.length; i++) {
    const row = curveSheet[i];
    if (!row || row.length === 0) continue;

    const rawDate = row[dateCol];
    const rawYear = yearCol >= 0 ? row[yearCol] : null;
    const rawSOFR = row[sofrCol];

    if (rawDate == null || rawSOFR == null) continue;

    // Parse SOFR rate — handle both "3.67%" format and 0.0367 decimal
    let sofr = parseSOFRRate(rawSOFR);
    if (sofr == null) continue;

    // Parse date label (e.g. "February-26", "Feb-2026", "2026-02", etc.)
    const dateStr = String(rawDate).trim();
    let year = rawYear ? parseInt(rawYear) : null;
    let month = null;

    // Try "MonthName-YY" or "MonthName-YYYY"
    const monthYearMatch = dateStr.match(/^(\w+)-(\d{2,4})$/);
    if (monthYearMatch) {
      month = parseMonth(monthYearMatch[1]);
      const yrPart = parseInt(monthYearMatch[2]);
      if (!year) year = yrPart < 100 ? 2000 + yrPart : yrPart;
    }

    // Try Excel serial date number
    if (month == null && typeof rawDate === 'number') {
      const jsDate = excelDateToJS(rawDate);
      month = jsDate.getMonth() + 1;
      if (!year) year = jsDate.getFullYear();
    }

    // Try "YYYY-MM" ISO format
    if (month == null) {
      const isoMatch = dateStr.match(/^(\d{4})-(\d{2})/);
      if (isoMatch) {
        if (!year) year = parseInt(isoMatch[1]);
        month = parseInt(isoMatch[2]);
      }
    }

    if (month == null || year == null || isNaN(sofr)) continue;

    const label = `${MONTH_NAMES[month - 1]}-${String(year).slice(-2)}`;

    forwardCurve.push({
      date: label,
      year,
      month,
      sofr: parseFloat(sofr.toFixed(4)),
    });
  }

  console.log(`  Parsed ${forwardCurve.length} monthly data points`);

  if (forwardCurve.length === 0) {
    // Debug: dump first few data rows
    console.log('  First 5 data rows:');
    for (let i = headerRowIdx + 1; i < Math.min(curveSheet.length, headerRowIdx + 6); i++) {
      console.log(`    Row ${i}: ${JSON.stringify(curveSheet[i])}`);
    }
    throw new Error('No data points parsed from Excel');
  }

  const now = new Date();
  return {
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),
    source: 'Chatham Financial — Excel download',
    curveDate: `${MONTH_NAMES[now.getMonth()]}-${now.getDate()}-${now.getFullYear()}`,
    forwardCurve,
  };
}

function parseSOFRRate(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();

  // "3.67%" → 3.67
  if (str.endsWith('%')) {
    const val = parseFloat(str.replace('%', ''));
    return isNaN(val) ? null : val;
  }

  const num = parseFloat(str);
  if (isNaN(num)) return null;

  // 0.0367 → 3.67 (decimal format — rate < 1 means it's a fraction)
  if (num > 0 && num < 0.3) return parseFloat((num * 100).toFixed(4));

  // 3.67 → 3.67 (already in percent)
  if (num > 0 && num < 20) return num;

  return null;
}

function parseMonth(str) {
  const s = str.toLowerCase().substring(0, 3);
  const idx = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(s);
  return idx >= 0 ? idx + 1 : null;
}

function excelDateToJS(serial) {
  // Excel dates are days since 1900-01-01 (with a leap year bug)
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400000);
}

// ─── CME Fallback ───────────────────────────────────────────────────────────

async function fetchCMEFallback() {
  console.log('Fetching CME Term SOFR as fallback...');
  try {
    const res = await fetch(CME_TERM_SOFR_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const now = new Date();
    const forwardCurve = [];

    // CME strip rates — sofrRates from the curve section
    const latestCurve = data.resultsCurve?.[0];
    if (latestCurve?.rates?.sofrRates) {
      for (const pt of latestCurve.rates.sofrRates) {
        const rate = parseFloat(pt.price);
        if (!isNaN(rate)) {
          // CME gives tenor labels like "1Y", "2Y" etc — expand to monthly
          const tenor = pt.term;
          const yearMatch = tenor.match(/^(\d+)Y$/);
          if (yearMatch) {
            const targetYear = now.getFullYear() + parseInt(yearMatch[1]);
            const month = now.getMonth() + 1;
            forwardCurve.push({
              date: `${MONTH_NAMES[month - 1]}-${String(targetYear).slice(-2)}`,
              year: targetYear,
              month,
              sofr: rate,
            });
          }
        }
      }
    }

    // CME strip fixings — 1M, 3M, 6M, 1Y Term SOFR
    const latestStrip = data.resultsStrip?.[0];
    if (latestStrip?.rates?.sofrRatesFixing) {
      for (const fix of latestStrip.rates.sofrRatesFixing) {
        const rate = parseFloat(fix.price);
        if (!isNaN(rate)) {
          const offsetMonths = fix.term === '1M' ? 1 : fix.term === '3M' ? 3 : fix.term === '6M' ? 6 : fix.term === '1Y' ? 12 : null;
          if (offsetMonths != null) {
            const d = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
            forwardCurve.push({
              date: `${MONTH_NAMES[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`,
              year: d.getFullYear(),
              month: d.getMonth() + 1,
              sofr: rate,
            });
          }
        }
      }
    }

    // Sort and dedupe by year+month
    forwardCurve.sort((a, b) => (a.year * 100 + a.month) - (b.year * 100 + b.month));
    const seen = new Set();
    const deduped = forwardCurve.filter(pt => {
      const key = `${pt.year}-${pt.month}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  ✓ CME fallback: ${deduped.length} data points`);

    return {
      date: now.toISOString().split('T')[0],
      timestamp: now.toISOString(),
      source: 'CME Group — SOFR strip rates (fallback)',
      curveDate: `${MONTH_NAMES[now.getMonth()]}-${now.getDate()}-${now.getFullYear()}`,
      forwardCurve: deduped,
    };
  } catch (e) {
    console.log(`  ✗ CME fallback failed: ${e.message}`);
    return null;
  }
}

main();
