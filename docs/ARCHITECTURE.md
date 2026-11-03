# Architecture, calculations and limitations

## Stack
* **Server:** Node.js 22, no dependencies. `server/http.js` (router, sessions, CSRF, idempotency, security headers), `server/services/*` (one file per module), `server/db.js` (schema, migrations, settings).
* **Database:** SQLite via built-in `node:sqlite` (WAL mode, foreign keys on). Schema is applied by versioned migrations at start.
* **Front end:** vanilla JS modules, no build step (`public/`). All HTML built from an auto-escaping template tag (XSS-safe by default). Charts are hand-written SVG.
* **Exports:** CSV, XLSX (OOXML + zip) and PDF writers in `server/export.js`, no libraries.

## Data model (all 23 required entities)
`roles`, `users`, `sessions`, `password_resets` · `customers`, `customer_tags`, `customer_consent`, `suppression_list` · `suppliers`, `product_categories`, `products`, `inventory_movements` · `orders`, `order_items`, `order_history` · `payments`, `payment_allocations` · `expenses` · `notifications`, `email_outbox` · `whatsapp_templates`, `whatsapp_campaigns`, `whatsapp_messages`, `campaign_attributions`, `saved_segments` · `recommendations` · `exchange_rates` · `audit_logs` · `business_settings`, `counters`, `idempotency_keys`.

Two SQL **views** are the single source of truth for order money (`v_orders`, `v_orders_fin`): paid amount, balance, payment status and base-currency values are *derived* from payment allocations, never stored. That means they cannot drift out of sync.

## Money rules
* All amounts are **integers in 1/100 of the currency unit** (including LBP). Rounding happens once per line.
* `Revenue (net) = Σ(qty × price) − discount + additional charges + delivery fee` (tax excluded: it is owed to the tax authority, not income).
* `Total due = net revenue + tax`. `Direct cost = Σ(qty × unit cost snapshot) + extra order costs`. `Gross profit = revenue − direct cost`.
* `Balance = amount due − payments allocated`. Cancelled / returned / draft orders have *amount due = 0*; payments already received on them show as **customer credit** (refund due), never as negative revenue.
* **Revenue recognition** (Settings): confirmed / delivered / completed, by recognition date. Default: delivered.
* **Net profit = gross profit − operating expenses. Cash flow = payments − refunds − expenses.** Unpaid orders are revenue but not cash. Voided payments are excluded everywhere; a payment is only ever counted once.
* **Currencies:** each order / payment / expense stores its own exchange rate (units per 1 reporting currency). Consolidated figures convert each transaction at its own stored rate and say so. A payment in another currency than its order is converted via the reporting currency. Cash by currency is shown unconverted.
* **Stock:** a per-order *ledger sync* makes stock movements equal to what the order's status and items require (deduct at the configured status, restore on cancel/return, adjust on edit). It is idempotent: repeating an action never double-counts.
* **Double submission:** every create endpoint honours an `Idempotency-Key` header (the UI sends one per open dialog). All multi-row writes run in one transaction.

## Security
* scrypt password hashing; random session tokens stored hashed; `HttpOnly; SameSite=Lax` cookie (`Secure` behind HTTPS); login throttling (8 failures / 15 min / address+email).
* CSRF: state-changing requests need a custom header **and** a same-origin `Origin`.
* Role-based permissions enforced on the server for every route; **cost / profit / margin fields are stripped from API responses** for users without `finance:read`, and the server ignores client-supplied cost for those users.
* CSP forbids inline scripts. Audit log records who/what/before/after for sensitive changes (orders, payments, expenses, products, users, settings, consent, campaigns, logins).
* Webhooks require a valid HMAC signature (`X-Hub-Signature-256`).

## Measured performance and robustness
Measured on a small cloud VM, one Node process, SQLite file (40,000 orders, 5,000 customers, ~27,000 payments, 20 MB database):

| Operation | Time |
|---|---|
| Orders list / search (by name or phone) | 55-100 ms |
| Customer list with lifecycle calculation / profile | 180-240 ms / 80-120 ms |
| Dashboard, first load for a period (then cached until the next write, max 30 s) | ~1.0 s |
| 20 people opening the dashboard at once | 1.1 s total |
| Finance summary / receivables / WhatsApp segments | 0.13 s / 0.4 s / 0.7 s |
| Excel / PDF export of 5,000 customers / 30 days of orders | 0.3 s / 0.2 s |
| Recommendations refresh / alert check | 0.6 s / 0.3 s |

Mixed soak (random orders, edits, status changes, payments, voids, refunds, stock, expenses, reports, analytics): **~90 operations/s with 12 concurrent workers; p50 70 ms, p95 650 ms; zero server errors**, and afterwards every invariant held (paid == sum of live allocations, no payment over-allocated, stock == sum of movements, unique order numbers, foreign keys, SQLite integrity). With the heap capped at 96 MB the server handled 6,000+ extra requests with flat memory.

What scale means here: this is one process doing synchronous database work, so a slow request delays others. It is comfortable for a small business (a few users, tens of thousands of orders). It is not designed for hundreds of simultaneous users or millions of rows. For that you would move to PostgreSQL and multiple workers.

Pressure-testing found and fixed: a dashboard that took 2.3 s (32 s for 20 concurrent users), notification floods (11,000 alerts from a large backlog; now capped at 25 + a summary), malformed JSON bodies returning 500, lenient number parsing (`"1e3"`, `true`), a payment that had been refunded being voidable (making an order's paid amount negative), and dialogs staying open across page navigation.

## Verified vs. not verified
**Verified by automated tests / browser runs:** everything in the README table except the live third-party services below. The UI was driven end-to-end in headless Chromium (first-run setup → product → customer → order → status → payment → dashboard, dark mode persistence, mobile menu and no horizontal overflow at 390 px width).

**Not verified (needs your accounts):**
* **WhatsApp Cloud API**: tested against a simulated Graph API only. See `WHATSAPP_SETUP.md` step 7.
* **SMTP**: tested against a local fake SMTP server (plain). STARTTLS / implicit TLS code paths exist but were not exercised against a real provider.
* **AI analysis** (Anthropic API): code present, requires `ANTHROPIC_API_KEY`; not exercised.
* **Docker image**, **HTTPS reverse proxy**, and real mobile devices (only emulated viewport checks).

## Known limitations (be aware before relying on it)
* **Single server, single SQLite file.** Great for one business (tens of thousands of orders). It is not a multi-tenant or horizontally scalable design.
* **Negative stock is allowed on sales** (a real sale should not be blocked by a counting error). Out-of-stock alerts fire and recommendations ask for a stock check.
* **PDF export is Latin-1 only**: Arabic/other scripts appear as `?` in PDFs. Excel and CSV are fully Unicode, so use those for such data.
* **Stock purchases are not expenses** in the accounting model (cost is recognised when goods are sold). If you want cash-basis tracking of inventory buying, also record those purchases as an expense category; this is documented in the KPI definitions.
* A product has one price/cost currency; it's converted to the order currency at the order's rate.
* Order-level discounts are not spread across products, so *product profitability* uses line revenue before order discounts (noted on the report).
* Revenue history follows the *current* recognition rule if you change it; "outstanding over time" uses current order values.
* Campaign "attributed orders" = orders within N days after a customer received a message. It indicates influence, not proof of causation.
* Recommendations are rules over your data with transparent assumptions; their "expected benefit" is an **estimate**, labelled as such.
* The notification "check" runs every 5 minutes; event alerts (new order, payment) are immediate.
* Not included: barcode scanning, invoicing/PDF invoices with legal numbering, tax filing, accounting-package export, multi-warehouse, offline mode.


---

# Hosted service (multi-customer) – added architecture

## Tenancy
* **One SQLite database per workspace** (`data/tenants/<id>.sqlite`) plus one **control database** (`control.sqlite`: accounts, plans, subscriptions, invoices, passes, admin users, audit).
* The workspace is chosen **only** from the `Host` header (`shop.yourdomain.com`), bound with `AsyncLocalStorage`. `X-Forwarded-Host`, headers, cookies and request bodies can never select a workspace. With no workspace bound, any database access **throws** (fail-closed).
* An LRU pool keeps up to `TENANT_POOL_MAX` (default 200) databases open; migrations run lazily on first open (`npm run migrate:all` does them all); a failed migration disables only that workspace and emails you.
* Background jobs run per workspace, fairly (rotating start, time budget, concurrency cap), and one workspace failing never stops the others.
* **Isolation is a release blocker:** `tests/isolation.test.js` plants unique markers in each workspace and tries every read path and cross-host trick; mutation testing found (and we fixed) a real cache leak (dashboard cache key lacked the workspace).

## One device per login
Hosted workspaces keep **one active session per user** by default (`SESSION_LIMIT`, per-workspace override in admin). A new sign-in ends the older session. Support/demo sessions are exempt. This stops casual sharing of a login (including via an APK/WebView wrapper, since it is enforced on the server). It cannot stop someone handing over the password; the previous user is simply signed out.

## Billing model
Plans/limits/features are rows in the control database (editable in the admin console). Lifecycle: `trialing → active → past_due (7 days) → suspended (read-only) → canceled → deleted (soft, 60 days) → purged`; evaluated lazily on every request so a missed job tick can never keep a lapsed workspace open. Reading and exporting are **never** blocked. Free passes (admin or code) are just `active` with `paid_through` set and a `comp` flag; they never count as revenue.

## Secrets and keys
Per-workspace integration secrets (WhatsApp, SMTP) are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`; each ciphertext carries a key id. **Rotation:** generate a new key, move the old into `APP_ENCRYPTION_KEY_OLD`, restart; each secret is re-encrypted with the new key the next time it is saved (a bulk re-encrypt command is not written yet, so keep the old key until every workspace has saved its settings, or until you accept losing the old secrets and ask customers to re-enter them). Backups use their own key (`BACKUP_ENCRYPTION_KEY`).

## Measured on this development machine (4 vCPU Xeon @ 2.8 GHz, sandbox; Node 22)
`npm run loadtest` (200 workspaces, 40 concurrent users, mixed reads/writes across *all* workspaces, real HTTP, 20 s):

| Pool size | Throughput | Read p50 / p95 / p99 | Write p50 / p95 / p99 | Memory |
|---|---|---|---|---|
| 300 (all workspaces stay open) | **305 req/s** | 114 / 207 / 323 ms | 119 / 212 / 668 ms | 334 MB |
| 100 (heavy open/close churn) | 182 req/s | 201 / 319 / 708 ms | 204 / 304 / 522 ms | 254 MB |

* 0 errors in either run. An empty workspace is ~364 KB on disk and costs roughly 0.6 MB of RAM when open.
* Node is single-threaded: this is roughly "one busy CPU core". Treat ~300 req/s as the ceiling of **one process**; a small business generates a few requests per minute, so this is thousands of ordinary customers in theory. **That is an extrapolation, not a measurement of real customer behaviour.**
* **Set `TENANT_POOL_MAX` ≥ the number of workspaces active at the same time** (the pool churn row shows why).
* Logins are deliberately slow (scrypt ≈ 65 ms CPU, blocking the process): a burst of hundreds of logins in the same second will queue. Not a concern at launch; if it becomes one, move hashing to worker threads.
* Not measured: real internet latency, TLS, a much larger data volume per workspace (the original single-business soak test covered 50k+ orders), disk-bound behaviour on slow storage.

## Scaling path
1. Bigger VPS (more RAM → bigger pool).
2. **Shard by workspace:** add a `node` column to `tenants` and route by it in the proxy (Caddy can pick an upstream per hostname). Each node runs the same image with its own `TENANTS_DIR`; the control database stays on one node (or moves to a small Postgres later). Moving a workspace = suspend, copy one file, update `node`, reactivate.
3. Nothing in the design shares state between workspaces, which is why step 2 needs no data-model change.

## Verified vs not verified (hosted service)
**Verified by automated tests (240+) and/or by driving the real pages in a browser:** tenant isolation, host resolution, signup/verification, lifecycle & lapse rules, plan limits, free passes, one-device rule, admin console (TOTP, replay protection, throttling), support sessions, CSV import/export, per-workspace WhatsApp webhooks (signature before parsing), click-to-chat, manual billing + gap-free invoice numbers, PDF engine (Arabic shaping, rendered and read back), Paddle webhook handling with **signed fake webhooks** (signature scheme from Paddle's docs), encrypted backup → restore → drill, SigV4 against the published AWS test vector, graceful shutdown, production boot.

**NOT verified (needs the real thing):**
* Paddle live/sandbox end-to-end (checkout overlay CSP hosts, API calls written from documentation), and **whether Paddle can pay you out from Lebanon**.
* Whish Pay (not integrated), Meta coexistence payload shapes, Meta Tech Provider flow.
* A real SMTP provider, real DNS/wildcard TLS with Caddy, the **Docker image build** (no Docker daemon in the development sandbox: the CI workflow builds and boots it on every push), S3 against a real provider (tested against a fake that checks signatures).
* Real phones/tablets and Safari/Firefox (browser checks used Chromium only).
* The legal pages (drafts; lawyer needed).
