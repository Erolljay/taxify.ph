# Txform.ph — Operations Instructions

Living runbook for operating the live infrastructure. Part of the ECC tracking
triad (`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Keep current from real changes, not
hand-waved.

_Last updated: 2026-07-13_

---

## Server

- **EC2:** `txform-server` (`i-09bbc637afe847bde`), t3.small, Ubuntu, region
  `ap-southeast-1` (Singapore). Account `erolljay-txform` (521605043764).
- **Clock is UTC.** Manila = UTC+8, so any 2 AM Manila schedule is `18:00 UTC`.
- **Manager.io** runs as `/home/ubuntu/ManagerServer` (not Docker). Live business
  data: `/home/ubuntu/Documents/Manager.io/` (`Businesses/` + `Trash/`).

---

## Backups

Two independent systems, both at **2 AM Manila (18:00 UTC)** with **7 / 56 / 400-day**
retention (daily / weekly / monthly).

### 1. AWS Backup — full-server snapshots
Restores the entire instance if the machine is lost.

- Vault: `txform-backup-vault`
- Plan: `txform-daily-weekly-monthly` — Daily `cron(0 18 * * ? *)` (7d), Weekly
  `cron(0 18 ? * SAT *)` (56d), Monthly `cron(0 18 L * ? *)` (400d).
- Resource assignment `all-ec2-instances` (all EC2, Default service role).

### 2. S3 data backup — portable Manager.io data
Downloadable `.tar.gz` of just the businesses. Runs on the server.

- Script: `/home/ubuntu/backup-managerio.sh` — tars `/home/ubuntu/Documents/Manager.io`,
  picks `monthly/` (1st) → `weekly/` (Sun) → `daily/` folder, uploads, keeps the
  local file only if the upload fails, logs to `/home/ubuntu/backup.log`.
- Cron (ubuntu user): `0 18 * * * /home/ubuntu/backup-managerio.sh 2>> /home/ubuntu/backup-errors.log`
- Bucket: `txform-managerio-backups` (own account; all public access blocked;
  lifecycle expiry `daily/`→7d, `weekly/`→56d, `monthly/`→400d).
- Auth: instance IAM role `txform-server-backup-role` → policy
  `txform-s3-backup-write` (`s3:PutObject` on the bucket only — no keys stored).

### How to check it's working
- **Data backups:** S3 console → `txform-managerio-backups` → `daily/weekly/monthly`
  fill daily. On the server: `cat /home/ubuntu/backup.log` (OK lines);
  `cat /home/ubuntu/backup-errors.log` (empty = healthy).
- **Snapshots:** AWS Backup → **Jobs** → "Completed" each morning.

### How to restore (when needed)
- **A business:** download the `.tar.gz` from S3, unzip, drop the `Manager.io`
  folder back into `/home/ubuntu/Documents/`, restart ManagerServer.
- **Whole server:** AWS Backup → recovery points → restore the instance/volume.

> Note: the server's role is **write-only** by design — it cannot list or delete
> bucket objects. Verify/restore from the console, not from the server CLI.

---

## Caveats / notes
- The `esmeres-managerio-backups` bucket + script your partner shared were only a
  **sample** — the live setup is the `txform-managerio-backups` one above. Don't
  re-point backups at `esmeres`.
- Backup is a live file-level tar of SQLite `.manager` files; running at 2 AM
  (idle) keeps it consistent. The script tolerates benign tar "file changed"
  warnings.
- Not yet done (optional hardening): immutability (AWS Backup **Vault Lock**, S3
  **Object Lock**) and a **failure email alert**. See [`docs/to-do.md`](to-do.md).
