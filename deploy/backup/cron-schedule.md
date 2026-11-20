# Coolify Backup - Cron Schedule & Automation

## Recommended Cron Schedule

Add these to your crontab (`crontab -e`) on the OCI VM running Coolify:

```cron
# ┌───────────── minute (0-59)
# │ ┌──────────── hour (0-23)
# │ │ ┌────────── day of month (1-31)
# │ │ │ ┌──────── month (1-12)
# │ │ │ │ ┌──────── day of week (0-6) (Sunday=0)
# │ │ │ │ │
# │ │ │ │ │
# ┌─────┴─────┴─────┴─────┴─────┴───────── command

# Daily at 2:00 AM - Coolify instance config backup
0 2 * * * /opt/instinct-gateway-src/deploy/backup/backup-all.sh coolify >> /var/log/coolify-backup.log 2>&1

# Daily at 3:00 AM - Database backups (PostgreSQL, MySQL, MongoDB)
0 3 * * * /opt/instinct-gateway-src/deploy/backup/backup-all.sh databases >> /var/log/coolify-backup.log 2>&1

# Daily at 4:00 AM - Docker volume backups
0 4 * * * /opt/instinct-gateway-src/deploy/backup/backup-volumes.sh >> /var/log/coolify-backup.log 2>&1

# Weekly on Sunday at 1:00 AM - Full backup (all of the above)
0 1 * * 0 /opt/instinct-gateway-src/deploy/backup/backup-all.sh all >> /var/log/coolify-backup.log 2>&1
```

## Alternative: Single Cron Entry (Recommended for Simplicity)

```cron
# Daily at 2:00 AM - Full backup (Coolify + DBs + Volumes)
0 2 * * * /opt/instinct-gateway-src/deploy/backup/backup-all.sh all >> /var/log/coolify-backup.log 2>&1
```

## Setup Steps

1. **Make scripts executable:**
   ```bash
   chmod +x /opt/instinct-gateway-src/deploy/backup/backup-all.sh
   chmod +x /opt/instinct-gateway-src/deploy/backup/restore.sh
   ```

2. **Create `.env` with OCI credentials:**
   ```bash
   cd /opt/instinct-gateway-src/deploy/backup
   cp .env.example .env
   # Edit .env with your OCI Object Storage credentials
   ```

3. **Add to crontab:**
   ```bash
   crontab -e
   # Paste one of the cron entries above
   ```

4. **Verify cron is running:**
   ```bash
   systemctl status crond  # or cron, depending on distro
   ```

5. **Test manually first:**
   ```bash
   /opt/instinct-gateway-src/deploy/backup/backup-all.sh all
   ```

## Log Rotation

Add to `/etc/logrotate.d/coolify-backup`:

```
/var/log/coolify-backup.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0644 root root
}
```

## Monitoring

Check backup status:
```bash
# View recent backup logs
tail -50 /var/log/coolify-backup.log

# Check OCI Object Storage bucket
aws s3 ls s3://your-bucket-name/coolify/ --endpoint-url https://<namespace>.compat.objectstorage.af-johannesburg-1.oraclecloud.com

# Verify last backup timestamp
ls -lh /tmp/coolify-backup-*/
```