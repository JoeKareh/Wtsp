# WhatsApp Business API: configuration guide

BizControl uses the **official WhatsApp Business Platform (Cloud API)** from Meta. It does not use WhatsApp Web automation or any unofficial method.

> **Status of this integration in this project:** it is fully built and was tested against a simulated Graph API (message payloads, signatures, receipts, consent rules, scheduling). It has **not** been run against Meta's live service, because that needs your credentials and Meta's approvals. Expect to do a short live test (step 7).

## What you need from Meta (cannot be done by the software)

1. A **Meta Business account** (business.facebook.com), ideally verified.
2. A **WhatsApp Business Account (WABA)** and a **phone number** registered to it (not already used on the regular WhatsApp app).
3. A **Meta developer app** with the *WhatsApp* product added.
4. **Message templates approved by Meta** (business-initiated messages can only use approved templates).
5. For marketing at volume: a verified business and a good quality rating. Messaging limits start low and grow.

## Step-by-step

### 1. Create the app and get the IDs
1. Go to developers.facebook.com → **My Apps → Create App** → type *Business* → add the **WhatsApp** product.
2. WhatsApp → **API Setup**. Copy:
   * **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   * **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
3. App → **Settings → Basic**: copy **App Secret** → `WHATSAPP_APP_SECRET` (used to verify that webhook calls really come from Meta).

### 2. Create a permanent access token
The temporary token expires in 24 h. For production:
1. Business Settings → **Users → System users** → add a system user (Admin).
2. **Add assets** → your app and your WhatsApp account, with full control.
3. **Generate token** for the app with permissions `whatsapp_business_messaging` and `whatsapp_business_management`, no expiry.
4. Put it in `WHATSAPP_TOKEN`.

### 3. Set the server environment variables
In `.env` (or your service environment) and restart the app:

```ini
WHATSAPP_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_BUSINESS_ACCOUNT_ID=9876543210
WHATSAPP_APP_SECRET=abcdef...
WHATSAPP_VERIFY_TOKEN=any-long-random-string-you-invent
```

Then in BizControl open **Settings → WhatsApp & integrations**. Every variable should show **set**. Click **Test connection**. It calls Meta and shows your verified business name and number. The status only says *Connected* after this real call succeeds.

### 4. Configure the webhook (delivery receipts, replies, STOP)
The app needs a **public HTTPS URL** (see the deployment guide). In Meta: App → WhatsApp → **Configuration → Webhook**:

* **Callback URL:** `https://YOUR-DOMAIN/webhooks/whatsapp` (also shown in Settings)
* **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
* Click **Verify and save**, then **subscribe** to the `messages` field.

Without the webhook, messages are still sent, but *delivered / read / replied* are not tracked and STOP replies are not processed. The app shows a warning in that case. Calls with an invalid signature are rejected.

### 5. Templates
Open **WhatsApp Marketing → Message templates**. Default templates are provided for promotions, offers, reactivation, thank-you, order confirmation, delivery update, payment reminder, recommendations and loyalty.

1. Check the wording (placeholders like `{customer_name}` become `{{1}}`… when sent to Meta).
2. Click **Submit**. The template shows *pending*.
3. After Meta reviews it (minutes to a day), click **Sync status from Meta**. It becomes *approved* and can be used.
4. Approved templates cannot be edited. Duplicate, edit the copy, submit that.

Tips that avoid rejection: don't start or end a message with a placeholder; keep marketing wording honest; use the **Utility** category only for genuine order/delivery/payment updates, because Meta reclassifies promotional content as Marketing.

### 6. Consent: your legal responsibility
WhatsApp requires **opt-in** before business-initiated messages. BizControl enforces this in software:

* Promotional (**Marketing**) templates go **only** to customers with a recorded opt-in. Consent is never assumed. Record it on the customer profile (how and when they agreed).
* Customers who reply **STOP** (configurable words) are opted out immediately and put on the suppression list. They are excluded from every future campaign, and consent is re-checked **immediately before each send**, even for campaigns already queued.
* Transactional (**Utility**) templates (order confirmation, delivery, payment reminder) don't need marketing consent, but they still respect opt-outs.
* Free-text replies are only possible within **24 hours** of the customer's last message (Meta's rule). Otherwise a template is required.

Check the rules that apply to you (local privacy and anti-spam law, WhatsApp Business Messaging Policy). The software helps enforce them but cannot guarantee compliance.

### 7. First live test (recommended)
1. Add yourself as a customer with your own WhatsApp number and record an opt-in.
2. Create a segment/campaign targeting only you (Custom segment with your category, or a tag).
3. Send. Verify: the message arrives; *delivered* and *read* appear in the campaign; replying **STOP** opts you out.

### Owner alerts on WhatsApp (optional)
Create an approved **Utility** template with exactly one variable (e.g. `Alert from your shop: {{1}}`), choose it in Settings → WhatsApp & integrations → *Owner alerts*, set your number under Settings → Notifications and tick **WhatsApp** on the alert rules you want.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test connection fails: *Invalid OAuth access token* | Token expired/wrong; create a system-user token |
| Campaign won't send: *template not approved* | Submit it, wait, then *Sync status* |
| Sent but never *delivered* | Recipient not on WhatsApp, or blocked marketing; check the error in the campaign message list |
| No *delivered/read/replies* | Webhook not verified/subscribed, or `WHATSAPP_APP_SECRET` is missing/wrong |
| Webhook verification fails | `WHATSAPP_VERIFY_TOKEN` differs from what you typed in Meta, or the URL isn't public HTTPS |
