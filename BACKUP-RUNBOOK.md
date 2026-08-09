# Harry The Marketer — backup & restore runbook

SQLite lives at `$DATA_DIR/harry-the-marketer.db` (WAL mode — copy `-wal` and `-shm` too).

## Daily backup (Render cron or manual)

```bash
cd "/path/to/Harry The Marketer"
DATA_DIR=/var/data npm run backup:db
```

Writes to `$DATA_DIR/backups/<timestamp>/` and prunes folders older than the last 14.

### Render cron job (optional)

Add a cron service in Render:

- **Schedule:** `0 4 * * *` (04:00 UTC daily)
- **Command:** `cd /opt/render/project/src && DATA_DIR=/var/data npm run backup:db`
- Mount the same `harry-data` disk at `/var/data`

For off-site retention, sync `$DATA_DIR/backups/` to S3 or another store (operator choice).

## Restore

1. Stop the web service (Render → Manual Suspend, or scale to 0).
2. Copy backup files over the live database:

```bash
BACKUP=/var/data/backups/2026-08-08T04-00-00
cp "$BACKUP/harry-the-marketer.db" /var/data/
cp "$BACKUP/harry-the-marketer.db-wal" /var/data/ 2>/dev/null || true
cp "$BACKUP/harry-the-marketer.db-shm" /var/data/ 2>/dev/null || true
```

3. Start the service.
4. Verify: `curl -s https://harrythemarketer.com/api/health` and sign in.

## Pre-deploy snapshot

Before risky migrations or manual DB edits:

```bash
DATA_DIR=/var/data npm run backup:db
```

## Single-instance constraint

Harry uses SQLite on a Render disk — **one web instance only**. Do not scale horizontally without migrating to Postgres.
