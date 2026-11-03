# WhatsApp in the hosted service

## Two modes

1. **One-tap chat (`wa.me`)** – every plan, every customer, zero setup. Opens WhatsApp with a ready, editable message; the user presses send. We record that the chat was *opened* (we cannot know it was sent). Phone numbers are normalised (Lebanon `03 123 456` → `+9613123456`, leading `0` dropped).
2. **Official WhatsApp Business Platform (Cloud API)** – automatic confirmations, 24-hour replies and bulk campaigns (Growth/Business). **Each customer connects their own Meta account**: their own token, phone number ID, business account ID and app secret, entered in *WhatsApp setup*. Credentials are encrypted per workspace (AES-256-GCM).

We never use unofficial WhatsApp automation (it gets numbers banned and is against WhatsApp's terms).

## Per-workspace webhook

Each workspace has its own callback URL `https://yourdomain.com/webhooks/whatsapp/<key>` and verify token, shown on the setup page. The signature (`X-Hub-Signature-256`, HMAC-SHA256 with that workspace's app secret) is verified on the **raw bytes before anything is parsed**; unknown keys and bad signatures get the same generic answer.

## Coexistence (same number in the WhatsApp Business app and the API)

The code has a seam for Meta's *coexistence* mode (`smb_message_echoes`, `history`, `smb_app_state_sync` webhook fields). **Payload shapes were written from Meta's public description and are UNVERIFIED** – confirm against a real coexistence-enabled number before selling it as a feature. The setup page only records that the number is also used in the Business app.

## If you want a one-click "Connect WhatsApp" (Embedded Signup)

That requires you to become a Meta **Tech Provider** (business verification + app review). It removes the copy-paste steps for customers but takes weeks and is not needed to launch. `WA_MODES.tech_provider.implemented` is `false`.

## Customer's responsibilities (also in the Acceptable Use draft)

Consent before marketing; opt-outs honoured immediately (the suppression list is enforced on every send); templates approved by Meta for messages outside the 24-hour window.
