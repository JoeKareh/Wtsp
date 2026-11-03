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
