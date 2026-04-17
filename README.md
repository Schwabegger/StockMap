# StockMap

A self-hosted inventory manager with a visual map of your storage spaces.

---

## What it does

**Items tab** — browse, search, and filter your inventory. Each item has a name, category, photos, and one or more storage locations with quantities. Click a location on an item to jump straight to it on the map.

**Map tab** — a canvas-based floor plan. Rooms are drawn as rectangles you place yourself. Double-click a room to enter it and see sub-locations. Rooms show how many items and sub-locations they contain. When navigating from an item, the target room is centered and highlighted with a short pulse so it's easy to spot.

**Manage tab** — admin-only. Add/edit/delete items, manage the category tree (hierarchical), manage locations, and set stock entries (location + quantity per item).

**Log tab** — full history of relocations and loans. Loans track who borrowed what, expected return date, and flag overdue items.

---

## Files

```
inventory.html        ← the app (single-file, served by the server)
server.js             ← Node.js backend (no npm install needed)
.env                  ← your config (copy from .env.example)
.env.example          ← config template
stock.json            ← items, locations, map layout (auto-created, not in git)
categories.json       ← category tree (auto-created, not in git)
transactions.json     ← relocation + loan history (auto-created, not in git)
images/               ← photo storage (auto-created, not in git)
  items/<id>/         ← item photos
  locations/<id>/     ← room photos
Dockerfile            ← for Docker deployment
docker-compose.yml    ← for Docker Compose deployment
start-server.bat      ← Windows shortcut
start-server.sh       ← Linux/Mac shortcut
```

---

## Running directly (no Docker)

Requires Node.js >= 16 (https://nodejs.org) — no npm install needed.

**1. Configure**

```bash
cp .env.example .env
```

Edit `.env` and set your passwords.

**2. Start**

Windows: double-click `start-server.bat`

Linux / Mac:
```bash
chmod +x start-server.sh
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

Credentials come from `.env`. Data persists in `stock.json`, `categories.json`, `transactions.json`, and `images/` on the host machine.

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

Copy `stock.json`, `categories.json`, `transactions.json`, and the `images/` folder. To restore, put them back and restart.
