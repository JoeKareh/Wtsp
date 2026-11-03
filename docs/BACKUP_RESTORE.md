# Backup and restore

Everything (customers, orders, payments, settings, users, audit log) is in **one SQLite file**, `data/bizcontrol.sqlite` (or wherever `DB_PATH` points). Expense attachments (receipts) are in `uploads/` next to it.

## Back up

### Option A: from the app (owner only)
**Settings → Backup → Download database backup.** This is a consistent copy made while the app runs. It does not include attachments.

### Option B: command line (recommended; schedule it)
```bash
npm run backup                      # -> backups/bizcontrol-YYYY-MM-DD-HH-MM-SS.sqlite (+ uploads copy)
npm run backup -- --dir /safe/place --keep 30
```
The script makes a consistent copy while the app is running, checks it with SQLite's integrity check, copies attachments, and removes copies beyond `--keep`. For a nightly schedule see the deployment guide (cron).

> **A backup that stays on the same server is not a backup.** Copy the files somewhere else (another computer, cloud storage) regularly, and **test a restore** at least once.

## Restore

Restoring **replaces all current data** with the backup. Do it on the server:

1. **Stop the app** (`sudo systemctl stop bizcontrol`).
2. Restore:
   ```bash
   npm run restore -- --file backups/bizcontrol-2025-01-31-02-15-00.sqlite --uploads backups/uploads-2025-01-31-02-15-00 --yes
   ```
   * The file is verified first (integrity + core tables). If it's damaged, **nothing is changed**.
   * Your current database is saved next to the original as `*.before-restore-<timestamp>` so you can undo.
   * `--uploads` is optional (restores attachments).
3. **Start the app** again.

Manual alternative: stop the app, delete `bizcontrol.sqlite-wal` and `-shm` if present, copy the backup over `bizcontrol.sqlite`, start the app.

## Moving to a new server
Install the app, copy the backup file over, run the restore command, copy `.env`, start. Sessions are stored in the database; users stay signed in only if the cookie settings match, otherwise they just sign in again.

## What is *not* in a backup
Environment variables (`.env`: WhatsApp token, SMTP password). Store those in a password manager.
