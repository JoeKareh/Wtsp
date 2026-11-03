# Deployment guide

BizControl is a single Node.js process with a SQLite file. A small VPS (1 vCPU / 1 GB RAM) is plenty for a small business.

## 1. Requirements

* Linux server (or any OS with Node)
* **Node.js 22.13 or newer** (`node -v`), because it uses the built-in `node:sqlite`
* A domain name and HTTPS if you will use WhatsApp (Meta requires a public HTTPS webhook)

## 2. Install

```bash
sudo useradd -r -m -d /opt/bizcontrol bizcontrol
sudo -u bizcontrol git clone <your-repo-url> /opt/bizcontrol/app   # or copy the folder
cd /opt/bizcontrol/app
sudo -u bizcontrol cp .env.example .env
sudo -u bizcontrol nano .env
```

Minimum `.env` for production:

```ini
PORT=3000
HOST=127.0.0.1                 # only the reverse proxy talks to it
DB_PATH=/opt/bizcontrol/data/bizcontrol.sqlite
BASE_URL=https://app.example.com
COOKIE_SECURE=true
TRUST_PROXY=true               # because nginx/Caddy sits in front
```

Keep the database **outside** the code folder (as above) so upgrades never touch data.

## 3. Run as a service (systemd)

`/etc/systemd/system/bizcontrol.service`:

```ini
[Unit]
Description=BizControl
After=network.target

[Service]
User=bizcontrol
WorkingDirectory=/opt/bizcontrol/app
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/opt/bizcontrol

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now bizcontrol
sudo journalctl -u bizcontrol -f     # logs
curl http://127.0.0.1:3000/api/health
```

## 4. HTTPS reverse proxy

**Caddy** (automatic certificates), `/etc/caddy/Caddyfile`:

```
app.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (with certbot):

```nginx
server {
    server_name app.example.com;
    client_max_body_size 12m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then open `https://app.example.com` and create the owner account.

## 5. Docker (optional)

```bash
docker build -t bizcontrol .
docker run -d --name bizcontrol --restart unless-stopped -p 127.0.0.1:3000:3000 \
  --env-file .env -e DB_PATH=/data/bizcontrol.sqlite -v bizcontrol-data:/data bizcontrol
```

> The Dockerfile has **not been build-tested** in the environment this project was developed in. It is straightforward (Node 22 + copy files), but please test it once before relying on it.

## 6. Scheduled backups

```bash
# crontab -e   (as the bizcontrol user)  -> nightly at 02:15, keep 14
15 2 * * * cd /opt/bizcontrol/app && DB_PATH=/opt/bizcontrol/data/bizcontrol.sqlite /usr/bin/node --disable-warning=ExperimentalWarning scripts/backup.js --dir /opt/bizcontrol/backups --keep 14
```

Copy `/opt/bizcontrol/backups` off the server regularly (another machine or cloud storage). See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## 7. Upgrading

```bash
cd /opt/bizcontrol/app && sudo -u bizcontrol node scripts/backup.js --dir ../backups
sudo -u bizcontrol git pull
sudo systemctl restart bizcontrol
```

Database migrations run automatically on start.

## 8. Background jobs

Started automatically with the server: campaign sender (10 s), email outbox (30 s), alert checks (5 min), recurring expenses (hourly), customer status refresh (hourly), recommendations (6 h), daily digest (at the configured hour). They run inside the same process. If the process is stopped, scheduled campaigns simply send when it starts again.

## 9. Security checklist

* HTTPS on, `COOKIE_SECURE=true`
* Strong owner password; create separate accounts for staff with the least access needed (Settings → Users)
* Keep `.env` readable only by the service user (`chmod 600 .env`)
* Run only **one** instance against a database file
* Keep the OS and Node updated
