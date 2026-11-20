# Coolify Backup - Implementation Guide

This directory contains the complete backup pipeline for your Coolify instance running on Oracle Cloud Infrastructure (OCI).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Backup Architecture                          │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Coolify     │───▶│  Backup      │───▶│  OCI Object    │      │
│  │  Instance    │    │  Scripts     │    │  Storage       │      │
│  │  (OCI VM)    │    │  (this dir)  │    │  (S3-compat)   │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                 │
│  ┌──────────────┐                                              │
│  │  Docker      │                                              │
│  │  Volumes     │                                              │
│  │  + Databases │                                              │
│  └──────────────┘                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `backup-all.sh` | Main backup script - coordinates database, volume, and Coolify instance backups |
| `restore.sh` | Restore script - recovers from backups |
| `cron-schedule.md` | Cron schedule recommendations and setup |
| `.env.example` | Environment variable template |
| `README.md` | This file |

## Quick Start

### 1. Create OCI Object Storage Bucket

In OCI Console:
- Storage → Object Storage → Create Bucket
- Name: `coolify-backups` (or your choice)
- Storage tier: Standard
- Access type: Private

### 2. Create OCI Customer Secret Keys

In OCI Console:
- Profile icon → My Profile → Customer Secret Keys
- Generate API Key → Copy Access Key and Secret Key

### 3. Configure Environment

```bash
cd /opt/instinct-gateway-src/deploy/backup
cp .env.example .env
nano .env  # Edit with your OCI credentials
```

### 4. Make Scripts Executable

```bash
chmod +x backup-all.sh restore.sh
```

### 5. Test Backup

```bash
./backup-all.sh all
```

### 6. Set Up Cron

See `cron-schedule.md` for cron job examples.

### 7. Test Restore

```bash
./restore.sh /tmp/coolify-backup-YYYYMMDD-HHMMSS/coolify-instance-*.tar.gz
```

## Environment Variables (.env.example)

| Variable | Description | Example |
|----------|-------------|---------|
| `OCI_OBJECT_STORAGE_ENDPOINT` | OCI Object Storage endpoint | `https://<namespace>.compat.objectstorage.af-johannesburg-1.oraclecloud.com` |
| `OCI_OBJECT_STORAGE_BUCKET` | Bucket name | `coolify-backups` |
| `OCI_ACCESS_KEY` | OCI Customer Secret Key access key | `ocid1.tenancy.oc1..aaaaaaa...` |
| `OCI_SECRET_KEY` | OCI Customer Secret Key secret key | `Jz...` |
| `COOLIFY_DATA_DIR` | Coolify data directory | `/data/coolify` |
| `BACKUP_RETENTION_DAYS` | Days to keep local backups | `7` |

## Architecture Decision: Block Storage vs Object Storage

| Factor | OCI Block Storage | OCI Object Storage |
|--------|-------------------|---------------------|
| **Purpose** | Fast VM rollback | Off-site disaster recovery |
| **Cost (Always Free)** | Counts against 200 GB limit | 10 GB free, then ~$0.0025/GB/mo |
| **Access** | Block-level, attach to VM | HTTP/S3 API, any location |
| **Redundancy** | Single AD | 3 Availability Domains |
| **Recovery Speed** | Minutes | Hours (download + restore) |
| **Best For** | VM snapshots, fast rollback | DB dumps, config exports, archives |

**Recommendation:** Use **both** — boot volume backups for fast VM recovery, Object Storage for application data and Coolify config.

## Recovery Scenarios

### Scenario 1: Accidental SOP deletion or config change
1. Restore Coolify instance from latest backup in OCI Object Storage
2. Restart Coolify
3. Verify SOP data is intact

### Scenario 2: Database corruption
1. Stop affected database container
2. Restore from latest database dump in OCI Object Storage
3. Restart database container

### Scenario 3: Complete VM loss
1. Provision new OCI VM
2. Install Docker + Docker Compose
3. Restore Coolify from Object Storage backup
4. Restore databases from Object Storage
5. Restore volumes from Object Storage
6. Enter `APP_KEY` from password manager
7. Redeploy all apps

### Scenario 4: Single file loss
1. Identify which volume contained the file
2. Restore that volume from OCI Object Storage
3. Copy file out of restored volume

## Security Considerations

1. **APP_KEY**: Never store in OCI Object Storage. Keep in password manager. Required to decrypt Coolify secrets on restore.
2. **OCI Secret Keys**: Store securely, rotate periodically.
3. **Backup encryption**: Consider encrypting backup tarballs before uploading to OCI for additional security.
4. **Access control**: Limit OCI Object Storage bucket access to only necessary IAM policies.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `aws: command not found` | Install AWS CLI: `curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && sudo ./awscliv2/install` |
| `AccessDenied` from OCI | Verify Customer Secret Key is correct and bucket exists |
| `Permission denied` on restore | Ensure you're running as root or with sudo |
| Coolify won't start after restore | Check that APP_KEY matches the one used when backup was created |
| Large backup times out | Increase timeout or split into smaller chunks |

## Support

For issues with this backup implementation, check:
1. `/var/log/coolify-backup.log` for recent backup logs
2. OCI Console → Object Storage → Buckets to verify uploads
3. OCI Console → Compute → Instances → Boot Volume to verify boot volume backups