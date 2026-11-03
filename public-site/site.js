'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const T = {
  en: { signin: 'Sign in', start: 'Start free trial', pricing: 'Pricing', features: 'Features', faq: 'FAQ', demo: 'Live demo', home: 'Home',
    h1: 'Run your orders, customers and money from one place', sub: 'Orders, customers, payments, stock and WhatsApp – built for small businesses. Works in Arabic and English, on phone and computer.', try: 'Try it free for 14 days', noCard: 'No credit card needed.', seeDemo: 'See the live demo',
    f_orders: 'Orders & invoices', f_orders_d: 'Create an order in seconds, track status, print or send a PDF invoice.', f_cust: 'Customers', f_cust_d: 'Everyone who buys from you, what they owe, and when to contact them again.', f_money: 'Money', f_money_d: 'Payments, who still owes you, expenses and profit – always up to date.',
    f_stock: 'Stock', f_stock_d: 'Know what you have, what is running low and what to re-order.', f_wa: 'WhatsApp', f_wa_d: 'Message customers in one tap on any plan. Bulk campaigns with the official WhatsApp API on Growth and Business.', f_ar: 'Arabic & English', f_ar_d: 'Right-to-left screens and Arabic PDF invoices that look right.',
    how: 'Ready in 10 minutes', how1: 'Create your workspace', how1d: 'Pick an address like yourshop.' , how2: 'Import your customers', how2d: 'Upload a CSV or Excel export. We tell you exactly which rows need fixing.', how3: 'Add your first order', how3d: 'Done. Your numbers start building up straight away.',
    month: 'Monthly', year: 'Yearly (2 months free)', permonth: '/ month', peryear: '/ year', choose: 'Start free trial', users: 'users', orders: 'orders / month', wam: 'WhatsApp campaign messages / month', pop: 'Most popular', unl: 'Unlimited',
    faq1q: 'Do I need a credit card for the trial?', faq1a: 'No. You get 14 days with full features. Add a payment method only if you want to continue.',
    faq2q: 'How do I pay?', faq2a: 'Cards worldwide through our payment partner. In Lebanon you can also pay by bank transfer, Whish or OMT, and we activate your account the same day.',
    faq3q: 'Is my data safe? Can I take it with me?', faq3a: 'Every business has its own separate database. You can download all your data as CSV files or a database file at any time, even after cancelling.',
    faq4q: 'Can my staff use it too?', faq4a: 'Yes, with their own logins and permissions. Each login works on one device at a time, so accounts cannot be passed around.',
    faq5q: 'What if I stop paying?', faq5a: 'You get a 7-day grace period, then the workspace becomes read-only. Your data is kept for 60 days and you can export it any time.',
    faq6q: 'Does WhatsApp need special approval?', faq6a: 'Opening a chat with a customer works instantly on every plan. Automatic and bulk messages use Meta’s official WhatsApp Business API and need your own approved number.',
    ready: 'Ready to try it?', signupT: 'Create your workspace', bizname: 'Business name', yourname: 'Your name', email: 'Email', pass: 'Password', passHint: 'At least 12 characters.', country: 'Country', currency: 'Currency', lang: 'Language', addr: 'Your address', passcode: 'Free pass code (optional)', create: 'Create workspace', checkMail: 'Check your email', checkMailD: 'We sent a confirmation link. Click it to activate your workspace.', terms: 'By creating a workspace you accept the Terms and Privacy Policy.',
    verifying: 'Confirming your email…', verified: 'Your email is confirmed!', openWs: 'Open my workspace', verifyFail: 'This link is invalid or expired.', findT: 'Find my workspace', findD: 'Enter your email and we send you the address of your workspace.', send: 'Send', sent: 'If we found workspaces for that email, we sent the addresses to it.',
    legalDraft: 'DRAFT – not yet reviewed by a lawyer. Do not rely on it until it has been reviewed for your country.', statusT: 'System status', allOk: 'All systems working', down: 'Some systems have problems',
    terms_l: 'Terms', privacy_l: 'Privacy', aup_l: 'Acceptable use', refund_l: 'Refunds', cookies_l: 'Cookies', dpa_l: 'Data processing', status_l: 'Status', find_l: 'Find my workspace', contact: 'Contact' },
  ar: { signin: 'تسجيل الدخول', start: 'ابدأ التجربة المجانية', pricing: 'الأسعار', features: 'المزايا', faq: 'الأسئلة الشائعة', demo: 'عرض تجريبي', home: 'الرئيسية',
    h1: 'أدِر طلباتك وعملاءك وأموالك من مكان واحد', sub: 'الطلبات والعملاء والدفعات والمخزون وواتساب – مصمم للأعمال الصغيرة. يعمل بالعربية والإنجليزية على الهاتف والكمبيوتر.', try: 'جرّبه مجاناً لمدة 14 يوماً', noCard: 'بدون بطاقة ائتمان.', seeDemo: 'شاهد العرض التجريبي',
    f_orders: 'الطلبات والفواتير', f_orders_d: 'أنشئ طلباً في ثوانٍ، تابع حالته، واطبع أو أرسل فاتورة PDF.', f_cust: 'العملاء', f_cust_d: 'كل من يشتري منك، وكم عليه، ومتى تتواصل معه مجدداً.', f_money: 'الأموال', f_money_d: 'الدفعات والديون والمصاريف والأرباح – محدّثة دائماً.',
    f_stock: 'المخزون', f_stock_d: 'اعرف ما لديك وما أوشك على النفاد وما يجب إعادة طلبه.', f_wa: 'واتساب', f_wa_d: 'راسل العملاء بضغطة واحدة في كل الباقات. وحملات جماعية عبر واجهة واتساب الرسمية في باقتي Growth وBusiness.', f_ar: 'عربي وإنجليزي', f_ar_d: 'شاشات من اليمين لليسار وفواتير PDF بالعربية بشكل صحيح.',
    how: 'جاهز خلال 10 دقائق', how1: 'أنشئ مساحة عملك', how1d: 'اختر عنواناً مثل yourshop.', how2: 'استورد عملاءك', how2d: 'ارفع ملف CSV أو Excel. نخبرك بالضبط أي الصفوف تحتاج تصحيحاً.', how3: 'أضف أول طلب', how3d: 'انتهى. أرقامك تبدأ بالتراكم فوراً.',
    month: 'شهري', year: 'سنوي (شهران مجاناً)', permonth: '/ شهر', peryear: '/ سنة', choose: 'ابدأ التجربة المجانية', users: 'مستخدمين', orders: 'طلب / شهر', wam: 'رسالة حملات واتساب / شهر', pop: 'الأكثر طلباً', unl: 'غير محدود',
    faq1q: 'هل أحتاج بطاقة ائتمان للتجربة؟', faq1a: 'لا. تحصل على 14 يوماً بكل المزايا. أضف وسيلة دفع فقط إذا أردت المتابعة.',
    faq2q: 'كيف أدفع؟', faq2a: 'بالبطاقة حول العالم عبر شريك الدفع. في لبنان يمكنك أيضاً الدفع بحوالة بنكية أو Whish أو OMT ونفعّل حسابك في اليوم نفسه.',
    faq3q: 'هل بياناتي آمنة؟ وهل أستطيع أخذها معي؟', faq3a: 'لكل نشاط تجاري قاعدة بيانات منفصلة. يمكنك تنزيل كل بياناتك كملفات CSV أو ملف قاعدة بيانات في أي وقت، حتى بعد الإلغاء.',
    faq4q: 'هل يستطيع موظفوني استخدامه؟', faq4a: 'نعم، بحسابات وصلاحيات خاصة بهم. كل حساب يعمل على جهاز واحد في الوقت نفسه، فلا يمكن تداول الحسابات.',
    faq5q: 'ماذا لو توقفت عن الدفع؟', faq5a: 'تحصل على مهلة 7 أيام ثم تصبح المساحة للقراءة فقط. نحتفظ ببياناتك 60 يوماً ويمكنك تصديرها في أي وقت.',
    faq6q: 'هل يحتاج واتساب إلى موافقة خاصة؟', faq6a: 'فتح محادثة مع العميل يعمل فوراً في كل الباقات. الرسائل التلقائية والجماعية تستخدم واجهة Meta الرسمية وتحتاج رقمك المعتمد.',
    ready: 'مستعد للتجربة؟', signupT: 'أنشئ مساحة عملك', bizname: 'اسم النشاط التجاري', yourname: 'اسمك', email: 'البريد الإلكتروني', pass: 'كلمة المرور', passHint: '12 حرفاً على الأقل.', country: 'الدولة', currency: 'العملة', lang: 'اللغة', addr: 'عنوانك', passcode: 'رمز مرور مجاني (اختياري)', create: 'إنشاء المساحة', checkMail: 'تحقق من بريدك', checkMailD: 'أرسلنا رابط تأكيد. اضغط عليه لتفعيل مساحة عملك.', terms: 'بإنشاء مساحة عمل فإنك توافق على الشروط وسياسة الخصوصية.',
    verifying: 'جارٍ تأكيد بريدك…', verified: 'تم تأكيد بريدك!', openWs: 'افتح مساحة عملي', verifyFail: 'هذا الرابط غير صالح أو منتهي.', findT: 'ابحث عن مساحة عملي', findD: 'أدخل بريدك وسنرسل لك عنوان مساحة عملك.', send: 'إرسال', sent: 'إذا وجدنا مساحات لهذا البريد فقد أرسلنا العناوين إليه.',
    legalDraft: 'مسودة – لم يراجعها محامٍ بعد. لا تعتمد عليها قبل مراجعتها لبلدك.', statusT: 'حالة النظام', allOk: 'كل الأنظمة تعمل', down: 'بعض الأنظمة بها مشاكل',
    terms_l: 'الشروط', privacy_l: 'الخصوصية', aup_l: 'الاستخدام المقبول', refund_l: 'الاسترداد', cookies_l: 'ملفات الارتباط', dpa_l: 'معالجة البيانات', status_l: 'الحالة', find_l: 'ابحث عن مساحة عملي', contact: 'تواصل' },
};
let lang = 'en'; try { const saved = localStorage.getItem('lang'); lang = saved || ((navigator.language || '').startsWith('ar') ? 'ar' : 'en'); } catch { /* storage blocked */ }
const t = (k) => (T[lang] && T[lang][k]) || T.en[k] || k;
function applyLang() {
  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $$('[data-t]').forEach((e) => { e.textContent = t(e.dataset.t); }); $$('[data-ph]').forEach((e) => { e.placeholder = t(e.dataset.ph); });
  const b = $('#lang'); if (b) b.textContent = lang === 'ar' ? 'English' : 'العربية';
}
document.addEventListener('DOMContentLoaded', () => {
  const b = $('#lang'); if (b) b.addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; try { localStorage.setItem('lang', lang); } catch { /* ignore */ } applyLang(); if (window.__rerender) window.__rerender(); });
  applyLang(); const p = document.body.dataset.page; if (PAGES[p]) PAGES[p]();
});
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : null; if (!r.ok) throw new Error((data && data.error) || 'Error ' + r.status); return data;
}
const money = (c, cur) => (c / 100).toLocaleString(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: c % 100 ? 2 : 0 });
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const x of kids.flat()) if (x != null) e.append(x.nodeType ? x : document.createTextNode(x)); return e; };

function renderPlans(box, plans, interval, linkBase) {
  box.replaceChildren(...plans.map((p) => {
    const price = interval === 'year' ? p.price_annual : p.price_monthly; const lim = p.limits || {};
    const feats = [`${lim.users} ${t('users')}`, `${lim.orders_month.toLocaleString()} ${t('orders')}`];
    if (lim.wa_marketing_month) feats.push(`${lim.wa_marketing_month.toLocaleString()} ${t('wam')}`);
    return el('div', { class: 'plan' + (p.code === 'growth' ? ' pop' : '') }, p.code === 'growth' ? el('span', { class: 'tag' }, t('pop')) : '', el('h3', {}, p.name),
      el('div', { class: 'price' }, money(price, p.currency), el('small', {}, ' ' + (interval === 'year' ? t('peryear') : t('permonth')))), el('ul', {}, feats.map((f) => el('li', {}, f))),
      el('a', { class: 'btn', href: `${linkBase}?plan=${p.code}` }, t('choose')));
  }));
}
const PAGES = {
  home() { pricingBlock(); faq(); demoLinks(); },
  pricing() { pricingBlock(); faq(); },
  signup() {
    const f = $('#f'); const msg = $('#msg'); const q = new URLSearchParams(location.search); if (q.get('pass')) f.pass.value = q.get('pass');
    api('GET', '/api/platform/countries').then((c) => {
      f.country.replaceChildren(...c.countries.map((x) => el('option', { value: x.code, 'data-cur': x.currency }, x.name))); f.currency.replaceChildren(...c.currencies.map((x) => el('option', { value: x })));
      const guess = (navigator.language || '').split('-')[1]; f.country.value = c.countries.some((x) => x.code === guess) ? guess : 'LB'; sync();
    });
    api('GET', '/api/platform/config').then((c) => { $('#domain').textContent = '.' + c.app_domain; });
    const sync = () => { const o = f.country.selectedOptions[0]; if (o) f.currency.value = o.dataset.cur; }; f.country.addEventListener('change', sync); f.lang.value = lang;
    let timer; const chk = $('#subchk'); f.subdomain.addEventListener('input', () => { clearTimeout(timer); chk.textContent = ''; timer = setTimeout(async () => { if (!f.subdomain.value) return; try { const r = await api('GET', '/api/platform/subdomain-check?name=' + encodeURIComponent(f.subdomain.value)); chk.className = 'hint ' + (r.available ? 'ok' : 'err'); chk.textContent = r.available ? '✓ ' + r.url : r.reason; } catch { /* ignore */ } }, 350); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); msg.className = 'msg'; msg.textContent = ''; const btn = f.querySelector('button'); btn.disabled = true;
      try {
        await api('POST', '/api/platform/signup', { business_name: f.business.value, owner_name: f.owner.value, email: f.email.value, password: f.password.value, country: f.country.value, currency: f.currency.value, language: f.lang.value, subdomain: f.subdomain.value.toLowerCase(), pass: f.pass.value || undefined });
        f.hidden = true; msg.replaceChildren(el('h2', {}, t('checkMail')), el('p', {}, t('checkMailD'), ' ', f.email.value)); msg.className = 'msg ok';
      } catch (x) { msg.className = 'msg err'; msg.textContent = x.message; btn.disabled = false; }
    });
  },
  async verify() {
    const box = $('#box'); const tok = new URLSearchParams(location.search).get('token');
    try { const r = await api('POST', '/api/platform/verify', { token: tok }); box.replaceChildren(el('h2', {}, '✓ ' + t('verified')), el('p', {}, el('a', { class: 'btn big', href: r.tenant_url }, t('openWs')))); }
    catch (x) { box.replaceChildren(el('h2', { class: 'err' }, t('verifyFail')), el('p', {}, x.message)); }
  },
  find() {
    const f = $('#f'); f.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/platform/discover', { email: f.email.value }); $('#msg').textContent = t('sent'); } catch (x) { $('#msg').textContent = x.message; } });
  },
  async status() {
    const box = $('#box'); try { const r = await fetch('/readyz'); const j = await r.json(); box.replaceChildren(el('div', { class: 'status-row' }, el('b', {}, 'BizControl'), el('span', { class: j.ok ? 'ok' : 'err' }, j.ok ? '● ' + t('allOk') : '● ' + t('down')))); }
    catch { box.replaceChildren(el('div', { class: 'status-row' }, el('b', {}, 'BizControl'), el('span', { class: 'err' }, '● ' + t('down')))); }
  },
};
function demoLinks() { $$('.demo-link').forEach((a) => a.addEventListener('click', async (e) => { e.preventDefault(); const w = window.open('', '_blank'); try { const r = await api('GET', '/api/platform/demo'); if (w) w.location = r.url; else location = r.url; } catch (x) { if (w) w.close(); alert(x.message); } })); }
let plansCache; async function pricingBlock() {
  const box = $('#plans'); if (!box) return; let interval = 'month';
  const draw = () => renderPlans(box, plansCache, interval, '/signup'); window.__rerender = () => { if (plansCache) draw(); faq(); };
  try { plansCache = await api('GET', '/api/platform/plans'); } catch { box.textContent = '—'; return; }
  $$('#toggle button').forEach((b) => b.addEventListener('click', () => { interval = b.dataset.i; $$('#toggle button').forEach((x) => x.classList.toggle('on', x === b)); draw(); })); draw();
}
function faq() { const box = $('#faq'); if (!box) return; box.replaceChildren(...[1, 2, 3, 4, 5, 6].map((i) => el('details', {}, el('summary', {}, t(`faq${i}q`)), el('p', {}, t(`faq${i}a`))))); }
