# Harry The Marketer — backup & restore runbook

SQLite lives at `$DATA_DIR/harry-the-marketer.db` (WAL mode). In production `DATA_DIR=/var/data`
(the Render disk mount — see `render.yaml`).

## How backups actually run (production)

Backups are taken **in-process by the app**, not by an external cron. `server/backup.js`
(`dailyBackup`) uses better-sqlite3's **online backup API**, which snapshots a *consistent*
database while writes continue — safe on a live server. The engine's upkeep loop
(`server/upkeep.js` → `job('daily_backup', dailyBackup)`) calls it every tick; the job gates
itself to **once per UTC day, after 04:00 UTC** (~2pm Sydney).

- **Output:** `$DATA_DIR/backups/<timestamp>/harry-the-marketer.db` + `manifest.json`.
  A single consistent `.db` file — **no `-wal` / `-shm` siblings** (that's the point of the
  online-backup API).
- **Retention:** the newest **14** folders are kept; older ones are pruned automatically.
- **Requires `DATA_DIR` to be set.** A dev checkout without `DATA_DIR` takes no backup
  (nothing durable to protect).

There is **no Render cron service** and none is needed — Render disks attach to a single
service, so a separate cron service could not mount the same `harry-data` disk anyway. The
in-app job is the mechanism.

### Verify a backup ran

Check the app logs for `[backup] daily backup written → …`, or list the folders:

```bash
ls -1 /var/data/backups
```

The newest folder should be dated today (after 04:00 UTC).

## Manual / pre-deploy snapshot

To force a snapshot immediately (e.g. before a risky migration), the same online-backup path is
preferred over the file-copy script. If you have a shell on the running instance you can trigger
the in-app job, or take an offline copy while the service is **suspended**:

```bash
# Offline only — service must be stopped so the WAL is checkpointed/quiet.
cd "/path/to/Harry The Marketer"
DATA_DIR=/var/data npm run backup:db
```

`scripts/backup-db.mjs` copies `harry-the-marketer.db` + `-wal` + `-shm` and a manifest. This is
**only safe on a stopped server** — on a live one the copy can catch the WAL mid-checkpoint.
Prefer the in-app online backup for anything on a running instance.

## Restore

Restore from an **online-backup** folder (the normal case): a single `.db` file, no WAL/SHM.

1. Stop the web service (Render → Manual Suspend, or scale to 0).
2. Remove any stale WAL/SHM from the live DB and copy the backup `.db` into place:

```bash
BACKUP=/var/data/backups/2026-08-12T04-00-00
rm -f /var/data/harry-the-marketer.db-wal /var/data/harry-the-marketer.db-shm
cp "$BACKUP/harry-the-marketer.db" /var/data/harry-the-marketer.db
```

3. Start the service.
4. Verify: `curl -s https://harrythemarketer.com/api/health` returns `{"ok":true,...}` and sign in.

> If you are restoring from an **offline** `npm run backup:db` folder instead (which *does*
> include `-wal`/`-shm`), copy all three files back together and do **not** delete the WAL first.

## Off-site copies (still an operator action)

Backups live on the **same Render disk** as the live database, so they protect against corruption
and bad deploys — **not disk loss**. For real durability, sync `$DATA_DIR/backups/` off-site
(S3, etc.). This is not yet automated. **Rehearse a restore at least once** before relying on it;
the go-live checklist's "restore tested" item should not be signed off until you have.

## Single-instance constraint

Harry uses SQLite on a Render disk — **one web instance only**. The daily-backup job, rate-limit
buckets, and the engine tick lock are all in-process. Do not scale horizontally without migrating
to Postgres.
