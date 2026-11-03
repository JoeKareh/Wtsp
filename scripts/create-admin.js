// Usage: node scripts/create-admin.js you@example.com "Your Name" "a-long-password"
// Prints the authenticator secret and recovery codes ONCE. Add the secret to Google Authenticator / Authy / 1Password.
import { createAdmin } from '../server/admin.js';
import { control } from '../server/control.js';
const [email, name, password] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: node scripts/create-admin.js <email> "<name>" "<password (12+ chars)>"'); process.exit(1); }
control();
const r = createAdmin(email, name || 'Admin', password);
console.log('\nAdmin created:', email, '\n\nAuthenticator setup key (type it into your authenticator app):\n  ', r.secret, '\nOr open this link on your phone:\n  ', r.uri, '\n\nRecovery codes (each works once; store them safely):\n  ', r.recovery.join('\n   '), '\n');
