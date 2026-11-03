// Country rules used at signup: calling code (for phone normalisation), time zone, default currency, default billing route.
export const COUNTRIES = {
  LB: ['Lebanon', '961', 'Asia/Beirut', 'USD'], SA: ['Saudi Arabia', '966', 'Asia/Riyadh', 'SAR'], AE: ['United Arab Emirates', '971', 'Asia/Dubai', 'AED'],
  JO: ['Jordan', '962', 'Asia/Amman', 'JOD'], EG: ['Egypt', '20', 'Africa/Cairo', 'EGP'], IQ: ['Iraq', '964', 'Asia/Baghdad', 'IQD'], KW: ['Kuwait', '965', 'Asia/Kuwait', 'KWD'],
  QA: ['Qatar', '974', 'Asia/Qatar', 'QAR'], BH: ['Bahrain', '973', 'Asia/Bahrain', 'BHD'], OM: ['Oman', '968', 'Asia/Muscat', 'OMR'], SY: ['Syria', '963', 'Asia/Damascus', 'USD'],
  PS: ['Palestine', '970', 'Asia/Hebron', 'ILS'], MA: ['Morocco', '212', 'Africa/Casablanca', 'MAD'], TN: ['Tunisia', '216', 'Africa/Tunis', 'TND'], DZ: ['Algeria', '213', 'Africa/Algiers', 'DZD'],
  TR: ['Türkiye', '90', 'Europe/Istanbul', 'TRY'], FR: ['France', '33', 'Europe/Paris', 'EUR'], ES: ['Spain', '34', 'Europe/Madrid', 'EUR'], DE: ['Germany', '49', 'Europe/Berlin', 'EUR'],
  IT: ['Italy', '39', 'Europe/Rome', 'EUR'], GB: ['United Kingdom', '44', 'Europe/London', 'GBP'], US: ['United States', '1', 'America/New_York', 'USD'], CA: ['Canada', '1', 'America/Toronto', 'CAD'],
  AU: ['Australia', '61', 'Australia/Sydney', 'AUD'], IN: ['India', '91', 'Asia/Kolkata', 'INR'], PK: ['Pakistan', '92', 'Asia/Karachi', 'PKR'], NG: ['Nigeria', '234', 'Africa/Lagos', 'NGN'],
  ZA: ['South Africa', '27', 'Africa/Johannesburg', 'ZAR'], BR: ['Brazil', '55', 'America/Sao_Paulo', 'BRL'], MX: ['Mexico', '52', 'America/Mexico_City', 'MXN'], OTHER: ['Other', '', 'UTC', 'USD'],
};
export const countryList = () => Object.entries(COUNTRIES).map(([code, [name, cc, tz, currency]]) => ({ code, name, cc, tz, currency, route: code === 'LB' ? 'manual' : 'paddle' }));
export const LANGUAGES = ['en', 'ar'];   // add 'fr' / 'es' by adding public/locales/<code>.json
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'LBP', 'SAR', 'AED', 'JOD', 'EGP', 'IQD', 'KWD', 'QAR', 'BHD', 'OMR', 'ILS', 'MAD', 'TND', 'DZD', 'TRY', 'CAD', 'AUD', 'INR', 'PKR', 'NGN', 'ZAR', 'BRL', 'MXN'];
export const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'admin', 'billing', 'mail', 'status', 'support', 'help', 'docs', 'blog', 'ftp', 'smtp', 'imap', 'pop', 'static', 'cdn', 'assets', 'login', 'signup', 'register', 'portal', 'dashboard', 'secure', 'account', 'accounts', 'root', 'ns1', 'ns2', 'demo', 'test', 'staging', 'dev', 'localhost', 'bizcontrol', 'paypal', 'stripe', 'paddle', 'whatsapp', 'meta', 'facebook', 'instagram', 'google', 'microsoft', 'apple', 'amazon', 'bank', 'webhooks', 'webhook', 'metrics', 'health', 'healthz', 'readyz', 'cloudflare']);
export const DISPOSABLE_EMAIL_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'throwawaymail.com', 'mintemail.com', 'mailnesia.com', 'spamgourmet.com', 'tempinbox.com', 'emailondeck.com', 'burnermail.io', 'mohmal.com']);
