# BizControl

Order management, CRM, financial tracking, inventory, WhatsApp marketing and sales intelligence for a small business, in one self-hosted web app.

* **Zero runtime dependencies.** Node.js ≥ 22.13 only (built-in SQLite, no `npm install` needed).
* **One process, one database file.** Back it up by copying a file.
* **Money is exact.** Amounts are stored as integers (1/100 of a unit) and every total is calculated on the server.

## Quick start

```bash
node -v            # must be v22.13 or newer
cp .env.example .env   # optional for now; needed for WhatsApp / email
npm start          # http://localhost:3000
```

Open the URL. The first screen asks you to create the **owner account** (there are no default passwords).
Then go to **Settings**: business details, time zone, currencies and the exchange rate (e.g. `LBP` = 89,500 per 1 USD).

### Try it with demo data (separate database)

```bash
npm run seed:demo      # creates data/demo.sqlite with fictional data
npm run start:demo     # login: demo@example.com / demo-pass-123
```

Demo data lives only in `data/demo.sqlite` and the UI shows a **DEMO DATA** banner. Your real database (`data/bizcontrol.sqlite`) is never touched.

## What's inside

| Area | What it does |
|---|---|
| **Orders** | Multi-item orders, discounts, delivery fee, tax, 10-status workflow, duplicate, cancel, history, overdue highlighting, a dedicated *Pending orders* board |
| **Customers** | Unique phone numbers (duplicate detection across all formats), full history, lifecycle (Active / At risk / Inactive / Prospect), loyal flag, tags, consent records |
| **Payments** | Ledger with partial payments, one payment across many orders, auto-allocation, refunds, edit, void, idempotent submission, customer credit |
| **Finance** | Accrual profit vs cash flow, receivables aging, multi-currency (USD/LBP) with per-transaction rates, full audit trail |
| **Inventory** | Stock movements, configurable deduction rule, min/max thresholds per product, fast/slow movers, shortage forecast |
| **Analytics** | Every KPI is clickable and drills into the underlying records; 12+ charts; period comparison; rule-based recommendations with evidence and *estimated* benefit |
| **Notifications** | In-app + email (immediate or daily digest), de-duplicated, auto-resolving |
| **WhatsApp** | Official Cloud API: approved templates, segments, scheduled campaigns, delivery/read tracking, replies, STOP handling, order attribution |
| **Reports** | 12 reports exported as Excel, CSV and PDF |
| **Admin** | Roles & per-user permissions, audit log, backup download, all business rules configurable |

## Documentation

* [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): run it for real (systemd, HTTPS, Docker)
* [`docs/WHATSAPP_SETUP.md`](docs/WHATSAPP_SETUP.md): getting and configuring WhatsApp Business API credentials
* [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md): backup and restore the database
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): data model, how calculations work, design decisions, **known limitations**

## Tests

```bash
npm test      # 70+ automated tests
```

The suite boots the real server against a throw-away database and covers customers & duplicate detection, order maths, partial / split / cross-currency payments, edit / void / cancel / refund, profit vs cash, inventory & alerts, lifecycle classification, WhatsApp consent enforcement (against a fake Graph API), webhook signatures, campaign scheduling, roles & restricted data, password reset, SMTP delivery, every report format, and backups.

### Pressure tests

```bash
npm run stress            # 5,000 customers / 40,000 orders: times every key endpoint, serial and concurrent
npm run soak -- 60 12     # 12 concurrent workers doing random operations for 60 s, then verifies all financial/stock invariants
```

`tests/hostile.test.js` (part of `npm test`) covers concurrency races (30 simultaneous payments on one order, duplicate-key retries, parallel order numbering, parallel duplicate customers, stock ledger), SQL-injection attempts on every filter, malformed/oversized bodies, numeric abuse, path traversal and cookie tampering.

## Configuration summary

Business rules (currencies, tax, revenue recognition, stock deduction, inactivity periods, thresholds, targets, alert rules, payment methods, categories, permissions) are set in the **Settings** screen. Secrets (WhatsApp, SMTP, AI) are **environment variables** only (see `.env.example`).
