// Cross-platform "VAR=value command" (Windows cmd/PowerShell cannot do that). Usage: node scripts/run.js DB_PATH=data/demo.sqlite -- server/index.js
import { spawn } from 'node:child_process';
const i = process.argv.indexOf('--'); const envs = process.argv.slice(2, i); const args = process.argv.slice(i + 1);
const env = { ...process.env }; for (const e of envs) { const k = e.indexOf('='); env[e.slice(0, k)] = e.slice(k + 1); }
const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: 'inherit', env });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => c.kill(s)); c.on('exit', (code) => process.exit(code ?? 1));
