# India Multiples Dashboard

Valuation-multiple band charts for Indian listed companies: **TTM PE, P/BV, Mcap/Sales and EV/EBITDA**, each with its mean and ±1 / ±2 standard-deviation lines. History comes from Ace Equity, daily and live updates from DHAN.

Live at **https://india-multiples-dashboard.vercel.app**. It has no logins: everyone shares the same profiles, sector tabs and companies, and anyone with the link can edit them, including on Admin (see [Safeguards](#safeguards)).

## Data sources

| Data | Source | How it gets in | When |
|---|---|---|---|
| PE, P/BV, Mcap/Sales, EV/EBITDA (consolidated and standalone), close, Mcap | Ace Equity "Query Expression" export | Uploaded on `/admin`. Stored in Neon only, never in this repo, because it's licensed. | After each quarter's results, or whenever you want to refresh |
| Daily closes | DHAN historical API | The daily job at 7:05 PM IST, or **Sync now** on `/admin` | Every evening |
| Live prices | DHAN quote API, batched for the open tab, cached 30 s | Read by the page: every 60 s in market hours (9:15–15:30 IST, Mon–Fri), every 10 min otherwise | Market hours |
| DHAN security IDs | DHAN's public scrip master | **Refresh DHAN list and auto-match** on `/admin` | When new companies arrive |
| Industry (sets the EV/EBITDA switch's default) | NSE Nifty 500 constituents file | Uploaded once on `/admin` | When NSE changes the index |
| Corporate actions, net debt | Entered by users | Each company's **Shares & corporate actions** panel | As they happen |

Only DHAN's market-data endpoints are used. The app never calls order, portfolio or funds endpoints.

## Daily routine

1. **Paste a fresh DHAN token on `/admin`.** DHAN tokens last 24 hours. Admin shows the expiry, amber under 3 hours and red once expired. The app tests the token with one quote call and checks that it was issued to the client ID you typed before saving it. The token is encrypted at rest and never shown again. If it has lapsed, live prices and the evening sync stop until a new one is saved.
2. **Nothing else, most days.** At 7:05 PM IST the daily job re-pulls the last 14 days of closes for every matched stock, so missed days fill themselves in. It then purges items in *Recently removed* that are older than 30 days. **Sync now** on `/admin` runs the same sync on demand.
3. **Review any ⚑ suggestions** in a company's *Shares & corporate actions* panel. A suggestion appears when DHAN's close drops overnight to about ½, ⅓, ¼, ⅕ or 1/10 (a split or bonus), or when Ace's implied share count moves more than 1%. **Review** opens a pre-filled form. **Not a corporate action** dismisses it. Nothing is applied without someone confirming it.

### After results (each quarter)

Once a quarter-end passes a company's last Ace date, its charts show an amber note: *"Results due — derived from <date> figures"*.

1. In Ace, export the Query Expression covering the new dates. It can cover any range and many companies per file; back-dated days are fine.
2. On `/admin`, under **Ace Equity upload**, pick the file. The preview shows each company's dates, how many days are new, changed or unchanged, and any day-on-day move over 25%, which is likely bad data. Check it, then **Save**.
3. Ace's values replace the derived days they cover, and the held figures move forward to the new results.
4. If the upload was wrong, **Roll back** on the latest batch restores exactly what it changed. You'll be asked to confirm first.

### Adding a company

A company joins the app through an Ace upload: include it in the export.

1. On `/admin`, press **Refresh DHAN list and auto-match**. A name that matches exactly is linked to its NSE symbol and DHAN security ID. Otherwise use **Pick…** once and the match is remembered.
2. Matching back-fills the company's closes straight away.
3. Then add it to any sector tab with the search box. Search only covers companies with Ace data.

## Methodology

Totals are in ₹ crore, prices in ₹ per share, share counts in crore.

**Ace is the source of truth** up to its last uploaded date. Its ratios move with price, and the figures behind them change only when results come out.

**Held figures (the anchor).** These are worked out for each company and basis, from up to the last 5 Ace days on or after the latest quarter-end. If a corporate action falls inside that quarter, only the days from the action onwards are used.

| Figure | From Ace |
|---|---|
| shares | Mcap ÷ close (Ace's own close, so a split-adjusted DHAN history can't distort it) |
| TTM PAT | Mcap ÷ PE |
| book value | Mcap ÷ P/BV |
| TTM sales | Mcap ÷ (Mcap/Sales) |

Each figure is the **median** over those days, which cancels most of Ace's 1-decimal rounding. A figure whose multiple is missing, zero or negative stays empty.

**Daily ratios after the last Ace day** are marked *derived*. Today's ratio during market hours is marked *live*, from DHAN's live price. With Mcap = price × shares held on that date:

- PE = Mcap ÷ TTM PAT. This is a market-cap (diluted) PE.
- P/BV = Mcap ÷ book value.
- Mcap/Sales = Mcap ÷ TTM sales.
- EV/EBITDA = (Mcap + net debt) ÷ EBITDA.

**Net debt and EBITDA.** Ace's export has no EV column, and EBITDA and net debt can't both be backed out of a single ratio. So net debt is **entered by hand** for each company and basis, as debt − cash + minority interest as of a date.

- **Once net debt is entered:** EBITDA = median over the anchor days of (Mcap + net debt) ÷ Ace's EV/EBITDA.
- **Until it is entered:** Ace's own EV/EBITDA history still shows, but derived and live EV/EBITDA and the EV implied prices are *n.m.*
- **Lenders:** EV/EBITDA is switched off by default for "Financial Services" companies (banks, NBFCs, HFCs, insurers), because debt is their raw material. Each company has a switch to change this.

**Corporate actions** change the held figures from their date onwards, for derived and live days only. Once a later Ace upload covers those days, Ace's values win.

| Action | Effect |
|---|---|
| Equity raise (QIP, preferential, rights) | shares + new; book value + new × price; net debt − new × price |
| Buyback | shares − n; book value − n × price; net debt + n × price |
| Bonus a:b | shares × (a + b) ÷ b. Market cap and every ratio stay continuous. |
| Split, face value F₀ → F₁ | shares × F₀ ÷ F₁. Market cap and every ratio stay continuous. |
| Other | a new share count, plus optional cash in or out |

A net-debt entry is moved by the cash of any action after its as-of date.

**Bands.** Over the chosen period (1Y, 2Y, 3Y, 5Y, Since Jan 2021 or Custom), using Ace, derived and live days alike:

- **Mean and SD:** the mean and the **sample standard deviation** (n − 1, as Excel's STDEV.S).
- **Current, z-score and percentile:** today's value, its z-score, and its percentile, meaning the share of days in the period at or below today's value.
- **Implied price** at each band, on today's figures: band × TTM PAT ÷ shares (likewise for book value and sales), or (band × EBITDA − net debt) ÷ shares for EV/EBITDA.

**Not meaningful (n.m.).** A loss-making PE, a negative EV/EBITDA, or a switched-off EV/EBITDA is *n.m.*. It's left out of the line and out of the mean and SD.

**Consolidated / Standalone.** Consolidated is the default. A company with no consolidated figures falls back to standalone and shows an **S** badge.

**Sector median.** For each day and metric, the median across the tab's companies that have a value that day, with its own bands. It changes when a company's history starts mid-way.

**Peer table.** For each metric, the current value, mean, z-score and percentile, plus the price at −1 SD, the mean and +1 SD of PE. It includes a sector-median row and is sortable.

## Excel export

**Download Excel (whole tab)** builds one workbook for the chosen period and basis:

- **One sheet per company:** its corporate actions and net-debt source, the data table, and four **native, editable Excel line charts**.
- **A Sector median sheet**, built the same way.
- **A Peer table sheet.**

The colours, dashed SD lines, no markers and legend order match the screen.

The page computes the series and POSTs them to [`api/export.py`](api/export.py), a Vercel Python function using `openpyxl`. `npm run verify:export` rebuilds a made-up workbook and checks every chart's colours, widths, dashes, markers, gridlines and titles.

## Running locally

Needs Node 24, Python 3.9+ with `openpyxl`, and the Vercel CLI linked to the project.

```bash
vercel env pull .env.local     # DATABASE_URL, SETTINGS_ENCRYPTION_KEY, CRON_SECRET
npm install
npm run dev                    # http://localhost:3000
npm run export:dev             # Excel export on :3010 (the dev server forwards /api/export to it)
```

Other scripts:

| Script | What it does |
|---|---|
| `npm test` | Vitest, made-up numbers only. Includes parity with the Gold NBFC dashboard's method, bonus continuity, and a worked QIP example. |
| `npm run typecheck`, `npm run lint` | TypeScript and ESLint checks. |
| `npm run db:push` | Applies `src/lib/db/schema.ts` to Neon (Drizzle). |
| `npm run db:status` | Lists the tables and the database size. |
| `npm run import-ace -- "<file.xlsx>" [profile]` | The Admin upload, from the command line. |
| `npm run verify:export` | Checks the Excel export on made-up data. |

If your network's DNS can't resolve `*.neon.tech`, run Node with a preload that resolves it through 1.1.1.1, or work against the deployed app instead.

## Deployment

**Hosting.** Vercel Hobby. Every push to `main` deploys. Functions run in `sin1` (Singapore), next to the Neon database (free tier, Singapore). `vercel.json` sets the framework, the region and the daily cron (`35 13 * * *` UTC = 7:05 PM IST).

**Environment variables:**

| Variable | What it holds |
|---|---|
| `DATABASE_URL` and related | Set by the Neon integration. |
| `SETTINGS_ENCRYPTION_KEY` | AES-256-GCM key for the DHAN client ID and token stored in the database. |
| `CRON_SECRET` | Vercel Cron sends it. `/api/cron/sync` refuses calls without it. |

**Storage.** About 115 bytes per stock-day of Ace data, plus closes. Roughly 95 MB for 500 stocks since 2021, growing about 23 MB a year, against the free 0.5 GB. Admin shows a gauge that warns at 80%.

## Safeguards

There's no password, by decision. Anyone with the link can change the DHAN token, upload or roll back Ace data, and edit any profile. To limit the damage:

- **DHAN token:** write-only. It's never returned to a browser or logged.
- **Confirm prompts:** every removal and rollback asks first, naming exactly what goes.
- **Bin:** removals go to *Recently removed* for 30 days, and anyone can restore them.
- **Rollback:** each Ace upload is a batch, and the latest can be rolled back.
- **Activity log:** every edit is recorded with the acting profile and time, shown on `/admin`.
- **Search engines:** every page carries `noindex, nofollow`.

Ace Equity data is licensed: it lives only in the database. Never commit an export, a seed file or a test fixture with real Ace numbers; `.gitignore` blocks `*.xlsx`, `*.xls` and `*.csv`.
