# Launch guide: from this code to customers paying you

Written for someone who is **not** a system administrator. Follow the steps in order. Anything marked ⏳ can wait until later.

You will have three websites on one server, from one install:

| Address | What it is |
|---|---|
| `yourdomain.com` | The website you sell (pricing, sign-up, demo) |
| `admin.yourdomain.com` | Your private console: customers, payments, free passes |
| `shopname.yourdomain.com` | Each customer's own workspace (the app) |

## What you need to buy / create (about 30 minutes)

1. **A domain name** (any registrar, about $12/year). 
2. **A free Cloudflare account**, and move your domain's DNS to Cloudflare (Cloudflare shows you how). This lets the server get one certificate that covers every customer address automatically.
3. **A server (VPS).** Hetzner, DigitalOcean or similar: 2 vCPU / 4 GB RAM / 40 GB disk is plenty for the first hundreds of customers (about $10–20/month). Choose **Ubuntu 24.04**.
4. **An email sender for the platform** (verification emails, receipts). Any SMTP service works: Brevo, Mailgun, Amazon SES, Postmark, or your own mailbox. You need host, port, username, password.
5. ⏳ **Backup storage (recommended)**: a Backblaze B2 or Cloudflare R2 bucket (cents per month).
6. ⏳ **Paddle account** for card payments (see "Card payments" below). You can launch without it: customers can pay you by bank transfer / Whish / OMT and you record it in the admin console, and you can give free passes.

## Step 1 – Point the domain at the server

In Cloudflare DNS add two records, both pointing to your server's IP address:

* `A`  `@`  → your server IP  (**DNS only**, grey cloud)
* `A`  `*`  → your server IP  (**DNS only**, grey cloud)

Create an API token: Cloudflare → My Profile → API Tokens → *Create token* → template **Edit zone DNS** → only your domain. Copy the token.

## Step 2 – Install on the server

Connect with SSH, then:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/JoeKareh/Wtsp.git bizcontrol && cd bizcontrol && git checkout saas
cp .env.example .env
nano .env
```

Fill in at least these lines of `.env`:

```ini
APP_DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
CLOUDFLARE_API_TOKEN=<the token from step 1>
SUPPORT_EMAIL=you@yourdomain.com
ALERT_EMAIL=you@yourdomain.com
PLATFORM_NAME=YourBrand
PLATFORM_LEGAL_NAME=Your Company Name
APP_ENCRYPTION_KEY=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
BACKUP_ENCRYPTION_KEY=<another one, same command>
PLATFORM_SMTP_HOST=...   PLATFORM_SMTP_PORT=587   PLATFORM_SMTP_USER=...   PLATFORM_SMTP_PASS=...   PLATFORM_SMTP_FROM="YourBrand <hello@yourdomain.com>"
MANUAL_PAYMENT_INSTRUCTIONS=Pay to IBAN ... / Whish number ... / OMT ... and use your reference.
```

> ⚠️ **Save `APP_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` in your password manager right now.** If you lose them, customers' stored WhatsApp credentials and all your backups can never be read again. Nobody, including me, can recover them.

Start everything:

```bash
docker compose up -d --build
docker compose logs -f app      # wait for "BizControl running", then press Ctrl+C
```

The first start builds Caddy and requests your wildcard certificate (1–3 minutes). Then open `https://yourdomain.com`.

## Step 3 – Create your admin login

```bash
docker compose exec app node --disable-warning=ExperimentalWarning scripts/create-admin.js you@yourdomain.com "Your Name" "a-long-unique-password"
```

It prints an **authenticator key** and **recovery codes** once. Add the key to Google Authenticator / Authy / 1Password, and store the recovery codes safely. Then sign in at `https://admin.yourdomain.com` with password + the 6-digit code.

## Step 4 – Test like a customer (15 minutes)

1. Open `https://yourdomain.com` → *Start free trial* → create a test business with an email you can read.
2. Click the email link, open the workspace, import a few customers, create an order, download the PDF invoice.
3. In the admin console open the customer → **Record a payment** (this is how bank/Whish/OMT payments are activated; the customer gets a PDF receipt by email).
4. Try **Give free days / Give unlimited** and **Create a free-pass code** (Free passes tab).
5. Sign in with the same login on a second browser: the first browser is signed out (one device per login). Admin → customer → *Devices allowed* changes that per customer.

## Step 5 – Look at the legal pages ⚠️

The pages under `/terms`, `/privacy`, `/acceptable-use`, `/refund`, `/cookies`, `/dpa` are **drafts, not legal advice.** Have a lawyer review them for Lebanon and for any country you sell in (the EU/UK have extra rules for personal data), fill the `[bracketed]` parts, then delete the yellow DRAFT box (edit `public-site/<page>.html`).

## Step 6 – Backups (do not skip)

The `backup` container makes an **encrypted** copy of every customer's database and your control database once a day into the `backups` volume, keeps 30 days, and uploads to S3-compatible storage if you set the `BACKUP_S3_*` lines in `.env` (do this: a backup on the same server is not a backup if the server dies).

Check it worked: `docker compose logs backup`.

**Prove restoring works – monthly:** `docker compose exec backup node --disable-warning=ExperimentalWarning scripts/restore-drill.js --dir /backups`. It restores random customers into a scratch folder and emails you if anything is wrong.

**Restore one customer:** suspend them in the admin console, then
`docker compose exec backup node --disable-warning=ExperimentalWarning scripts/restore-tenant.js --from /backups/<date-folder> --tenant <t_id> --force`, then reactivate. (The data volume is mounted read-only in the backup container, so for a real restore run it from the `app` container with the backups volume, or copy the folder in.)

## Step 7 – Monitoring

* `https://yourdomain.com/status` is a public health page. Point a free uptime monitor (UptimeRobot, BetterStack) at `https://yourdomain.com/readyz`.
* You get **emails** (to `ALERT_EMAIL`) when: a background job fails, a customer's database upgrade fails, a backup fails, the disk is over 80%.
* Optional: set `SENTRY_DSN` to see errors in Sentry; set `METRICS_TOKEN` and scrape `https://admin.yourdomain.com/metrics` with Prometheus.

## Updating the software

```bash
git pull && docker compose up -d --build
docker compose exec app node --disable-warning=ExperimentalWarning scripts/migrate-all.js   # optional: upgrades every database now (otherwise each upgrades on first use)
```

The app drains requests and closes databases cleanly when it stops. Take a backup first for big updates.

---

## ⏳ Card payments with Paddle (do this after you launch)

Nothing breaks without it: the Billing page shows "card payments are being set up", and Lebanon customers can use bank/Whish/OMT. When you are ready:

1. Create a Paddle account and complete their seller verification. **Check that Paddle can pay you out in your country/bank** (Lebanon payouts were **not verified**: ask Paddle support before relying on it; if it is a problem consider a company in a supported country, or use Paddle only for non-Lebanese customers and manual payments for Lebanese ones — the code already routes that way).
2. In **Paddle Sandbox** first: create 3 products (Starter, Growth, Business) each with a monthly and yearly **price**. Copy the 6 price IDs (`pri_...`).
3. In the admin console → **Plans**: paste each plan's monthly and yearly price ID into the "Paddle … price ID" boxes and press Save.
4. Paddle → Developer tools: create an **API key**, a **client-side token**, and a **notification destination** with URL `https://yourdomain.com/webhooks/paddle` subscribed to `subscription.*` and `transaction.*`; copy its **secret key**.
5. Put them in `.env`: `PADDLE_ENV=sandbox`, `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`. `docker compose up -d`.
6. Buy a plan with Paddle's test card (4242 4242 4242 4242). Check: the workspace turns *Active*, an invoice appears in Billing and in admin → Payments.
7. **Verify these things in the sandbox** (they were written from Paddle's documentation and not run against Paddle): the checkout opens (the Content-Security-Policy allows `*.paddle.com`; if the browser console shows a blocked URL, tell me), the webhook shows ✓ in Paddle's notification log, plan change, cancel, and a failed renewal (Paddle sandbox lets you simulate).
8. Switch to live: repeat 2–5 with live values and `PADDLE_ENV=production`.
9. Paddle is the **merchant of record**: it handles VAT/sales tax and invoices for card payments. Your own PDF invoices cover manual payments.

## AI assistant ("Ask your business") – optional

Set `ANTHROPIC_API_KEY` in `.env` (from console.anthropic.com) and restart. Growth and Business plans include it (200 / 1,000 questions per month, editable in Plans → "ai credits month"); each answered question uses one credit and **you pay Anthropic per question** (a few cents or less), so check that your plan prices cover it. The assistant can only call read-only tools over the customer's own data; phone numbers and emails are never sent. Not verified against the live Anthropic API in development (tested with a fake server).

## Whish Pay (online payments in Lebanon)

Stubbed, not live: Whish's merchant API terms must be confirmed with Whish Money (see `docs/WHISH_PAY.md`). Until then use manual payment.

## WhatsApp for customers

One-tap chat works for everyone with no setup. Official API (automatic/bulk messages) is the customer's own Meta setup: see `docs/WHATSAPP_SAAS.md`.
