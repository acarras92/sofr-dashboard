# SOFR Forward Curve Tracker

Daily automated scraper that pulls forward SOFR curve and swap rate data from Chatham Financial, stores a rolling history, and displays it on a live GitHub Pages dashboard.

**Live Dashboard:** [acarras92.github.io/sofr-dashboard](https://acarras92.github.io/sofr-dashboard/)

## What It Tracks

- **Term SOFR** — 1M, 3M, 6M, 12M CME Term SOFR fixings
- **SOFR OIS Swap Rates** — 1Y through 10Y spot-starting swap rates
- **Forward Curve** — Full forward SOFR curve across tenors
- **Curve Shape** — 2Y-10Y spread for steepness analysis

## Use Case

Built for a hotel real estate investor using floating-rate debt:
- Track forward rate direction for cap/hedge cost analysis
- Monitor rate compression for refi timing signals
- Understand curve shape (steep vs. flat vs. inverted) as a deal underwriting input

## Setup

1. Install dependencies: `npm install && npx playwright install chromium`
2. Create `.env` with `CHATHAM_EMAIL` and `CHATHAM_PASSWORD`
3. Run scraper: `node scrape.js`

## Automation

GitHub Actions runs the scraper every weekday at 8:30am ET. Set `CHATHAM_EMAIL` and `CHATHAM_PASSWORD` as repository secrets.
