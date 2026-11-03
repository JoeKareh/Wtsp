// Creates a SEPARATE demo database (data/demo.sqlite) with fictional data. Never touches your real database.
// Run:  npm run seed:demo    then   npm run start:demo   (login: demo@example.com / demo-pass-123)
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.env.DB_PATH || 'data/demo.sqlite');
if (path.basename(target) !== 'demo.sqlite' && !process.env.FORCE_DEMO_SEED) { console.error(`Refusing to seed ${target}: demo data may only be written to a file named demo.sqlite (set FORCE_DEMO_SEED=1 to override).`); process.exit(1); }
process.env.DB_PATH = target;
for (const ext of ['', '-wal', '-shm']) fs.rmSync(target + ext, { force: true });

const { run, get, all, setSettings, tx } = await import('../server/db.js');
const { ensureRoles, hashPassword } = await import('../server/auth.js');
const { ensureDefaultTemplates } = await import('../server/services/whatsapp.js');
const { seedDemoData } = await import('../server/seed.js');
const { nowIso } = await import('../server/util.js');

ensureRoles(); ensureDefaultTemplates();
const owner = { id: 1, name: 'Demo Owner', role: 'OWNER', permissions: ['*'] };
run('INSERT INTO users(email,name,password_hash,role_id,created_at) VALUES (?,?,?,?,?)', 'demo@example.com', 'Demo Owner', hashPassword('demo-pass-123'), get("SELECT id FROM roles WHERE name='OWNER'").id, nowIso());
setSettings({ business_name: 'Demo Olive & Soap Co. (DEMO DATA)', is_demo: true, owner_email: 'demo@example.com', daily_sales_target: 15000, monthly_sales_target: 400000, tax_enabled: false });
run('INSERT INTO exchange_rates(currency,rate_per_base,effective_date,note,created_at) VALUES (?,?,?,?,?)', 'LBP', 89500, '2020-01-01', 'Demo rate', nowIso());

const r = seedDemoData(owner);
const n = (t) => get(`SELECT COUNT(*) c FROM ${t}`).c;
console.log(`Demo database created at ${target}\n  ${n('customers')} customers, ${n('products')} products, ${n('orders')} orders, ${n('payments')} payments, ${n('expenses')} expenses\n  Start it with: npm run start:demo\n  Login: demo@example.com / demo-pass-123`);
