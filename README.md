# StockMap

## Files
```
inventory.html      ← the app (served by the server)
server.js           ← the server
.env                ← your config (edit this)
.env.example        ← config template
stock.json          ← your data (auto-created on first save)
images/             ← photo storage (auto-created)
  items/<id>/       ← item photos
  locations/<id>/   ← room photos
Dockerfile          ← for Docker deployment
docker-compose.yml  ← for Docker Compose deployment
start-server.bat    ← Windows shortcut
start-server.sh     ← Linux/Mac shortcut
```

---

## Running directly (no Docker)

Requires Node.js >= 16 (https://nodejs.org) — no npm install needed.

**1. Configure**

Copy `.env.example` to `.env` and edit your passwords:
```
cp .env.example .env
```

**2. Start**

Windows: double-click `start-server.bat`

Linux / Mac:
```bash
./start-server.sh
```

**3. Open** `http://localhost:3000` — browser will prompt for login.

---

## Running with Docker

```bash
# Build and start in background
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Credentials come from `.env`. Data persists in `stock.json` and `images/` on the host machine.

To update the app, replace the files and rebuild:
```bash
docker compose down && docker compose build && docker compose up -d
```

---

## Accounts

| Account | Default password | Access       |
|---------|-----------------|--------------|
| admin   | stockmap        | Read + write |
| guest   | readonly        | View only    |

Edit `.env` to change passwords. Restart the server after changes.

---

## Port

Change `PORT=3000` in `.env`. Also update the ports line in `docker-compose.yml` to match.

---

## Backups

Copy `stock.json` and the `images/` folder. To restore, put them back and restart.
