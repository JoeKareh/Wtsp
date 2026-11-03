# What is done, and what only YOU can do next

Everything that can be built and tested without your accounts, money or domain is built and tested (239 automated tests, plus real-browser checks on phone and desktop widths). What is left needs things I cannot do from here: buying a domain and server, logging in to other companies' dashboards, and a lawyer.

## ✅ Done (you do not need to do anything for these)

* **Sales website** (home, pricing, sign-up, email confirmation, find-my-workspace, status, legal draft pages), English + Arabic.
* **Your admin website**: customers, people, free passes (days or unlimited, or redeemable codes), payments and PDF invoices, plans and prices, activity log, emails. Password + authenticator code.
* **The customer app**: orders, customers, payments, stock, WhatsApp one-tap chat, billing page, onboarding checklist, CSV import, WhatsApp setup, help, "Ask your business" AI, Arabic/RTL, installable on phones (Add to Home screen).
* **One device per login**: a second sign-in signs the first one out. Sharing the website or an APK gives nobody access without their own login; you can allow more devices per customer in admin.
* **Money**: manual payments (bank / Whish / OMT / cash) with PDF receipts; Paddle code is written and tested with fake signed events (waits for step 9).
* **Hosting kit**: Docker, automatic HTTPS for every customer address, encrypted daily backups, restore drill, monitoring emails, CI.

## 🧭 Your checklist, in order

**A. Get it online (about 2 hours, mostly waiting)**
1. [ ] Buy a domain.
2. [ ] Create a free Cloudflare account and move the domain's DNS to it.
3. [ ] Rent a server: Ubuntu 24.04, 2 CPU, 4 GB RAM (Hetzner/DigitalOcean).
4. [ ] Create an email-sending account (Brevo, Mailgun, Amazon SES or similar) and note host, port, user, password.
5. [ ] Follow `docs/LAUNCH_GUIDE.md` steps 1–3 (DNS records, Docker install, `.env`, `docker compose up -d --build`, create your admin login).
6. [ ] **Save `APP_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` in a password manager.** Losing them is unrecoverable.

**B. Test it yourself (30 minutes)** – launch guide step 4: sign up as a fake customer, import customers, create an order, record a payment from the admin site, give a free pass, sign in on a second browser and see the first one get signed out.

**C. Before real customers**
7. [ ] Set up backup storage (Backblaze B2 / Cloudflare R2) and fill the `BACKUP_S3_*` lines. Run the restore drill once (launch guide step 6).
8. [ ] **Lawyer review of the legal pages** (they are drafts). Then remove the yellow DRAFT boxes.
9. [ ] Put your real bank / Whish / OMT details in `MANUAL_PAYMENT_INSTRUCTIONS`, and your real support email in `SUPPORT_EMAIL` and `ALERT_EMAIL`.
10. [ ] Point a free uptime monitor (UptimeRobot / BetterStack) at `https://yourdomain/readyz`.
11. [ ] Add your own screenshots in the WhatsApp setup page (the dashed boxes) – optional but helps customers.

**D. Later, one at a time (none blocks launch)**
12. [ ] **Card payments (Paddle)** – launch guide section "Card payments". First ask Paddle support whether they can pay you out in Lebanon.
13. [ ] **Android app**: the website is already installable. To publish on Google Play, wrap it with PWABuilder.com (free, "Android" package) using your sign-up site URL. I could not build or test an APK from here. Customers log in inside it with their own email and password, so the one-device rule applies the same way.
14. [ ] **Whish online payments**: ask Whish Money for merchant API access (see `docs/WHISH_PAY.md`).
15. [ ] **AI assistant**: add `ANTHROPIC_API_KEY` when you want it on; you pay per question.
16. [ ] **Official WhatsApp one-click connect** (Meta Tech Provider approval, weeks): only if customers struggle with the copy-paste setup.

## ❓ What I could not verify (tell Claude if any of these misbehave)
Card checkout and webhooks against the real Paddle · whether Paddle pays out to Lebanon · Whish · Meta's coexistence message formats · a real email provider · real DNS/HTTPS certificates · the Docker image build (CI builds it on every push) · Safari/Firefox/real phones · the AI assistant against the real Anthropic API.

## 💬 Paste this to Claude chat when you come back

> I'm building BizControl, a subscription SaaS (repo JoeKareh/Wtsp, branch `saas`). Read `docs/NEXT_STEPS.md` and `docs/LAUNCH_GUIDE.md` in the repo. I'm at step __ of the checklist. [Describe what you see / paste the error message.] Please tell me exactly what to click or type next, in simple language. If a step needs a code change, make it and push it to the `saas` branch.
