#!/bin/bash
# =============================================================================
# Coolify Backup Script - Complete Backup Suite
# =============================================================================
# Backs up:
#   - Coolify instance configuration (database + source .env)
#   - Docker volumes (persistent app data)
#   - Application databases (PostgreSQL, MySQL, MongoDB)
#   - Uploads everything to OCI Object Storage via S3-compatible API
#
# Usage:
#   ./backup-all.sh                    # Full backup
#   ./backup-all.sh --databases-only   # Only databases
#   ./backup-all.sh --volumes-only     # Only Docker volumes
#   ./backup-all.sh --coolify-only     # Only Coolify instance config
#
# Environment variables (set in .env):
#   OCI_OBJECT_STORAGE_ENDPOINT  - e.g. https://<namespace>.compat.objectstorage.af-johannesburg-1.oraclecloud.com
#   OCI_OBJECT_STORAGE_BUCKET    - Bucket name
#   OCI_ACCESS_KEY               - OCI Customer Secret Key access key
#   OCI_SECRET_KEY               - OCI Customer Secret Key secret key
#   COOLIFY_DATA_DIR             - Path to Coolify data dir (default: /data/coolify)
#   BACKUP_RETENTION_DAYS        - Days to keep local backups before cleanup (default: 7)
#
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/tmp/coolify-backup-$(date +%Y%m%d-%H%M%S)}"
COOLIFY_DATA_DIR="${COOLIFY_DATA_DIR:-/data/coolify}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# OCI Object Storage (S3-compatible)
OCI_ENDPOINT="${OCI_OBJECT_STORAGE_ENDPOINT:-}"
OCI_BUCKET="${OCI_OBJECT_STORAGE_BUCKET:-}"
OCI_ACCESS_KEY="${OCI_ACCESS_KEY:-}"
OCI_SECRET_KEY="${OCI_SECRET_KEY:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------
check_prereqs() {
  local missing=0

  for cmd in tar gzip curl aws; do
    if ! command -v "$cmd" &>/dev/null; then
      warn "Missing command: $cmd"
      missing=1
    fi
  done

  if [ "$missing" -eq 1 ]; then
    err "Please install missing dependencies and retry."
    exit 1
  fi

  # Validate OCI credentials if we're going to upload
  if [ -z "$OCI_ENDPOINT" ] || [ -z "$OCI_BUCKET" ] || [ -z "$OCI_ACCESS_KEY" ] || [ -z "$OCI_SECRET_KEY" ]; then
    warn "OCI Object Storage not fully configured. Backups will be local only."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# S3-compatible upload helper
# ---------------------------------------------------------------------------
s3_upload() {
  local local_file="$1"
  local remote_key="$2"

  if [ -z "$OCI_ENDPOINT" ] || [ -z "$OCI_BUCKET" ]; then
    warn "Skipping upload to OCI (credentials not configured)"
    return 0
  fi

  local remote_path="${OCI_BUCKET}/${remote_key}"
  log "Uploading to OCI Object Storage: ${remote_path}"

  if AWS_ACCESS_KEY_ID="$OCI_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$OCI_SECRET_KEY" \
     AWS_ENDPOINT_URL="${OCI_ENDPOINT}" \
     aws s3 cp "${local_file}" "s3://${remote_path}" --no-progress 2>/dev/null; then
    log "Upload complete: ${remote_path}"
    return 0
  else
    err "Failed to upload ${local_file} to OCI Object Storage"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 1. Coolify Instance Backup
# =============================================================================
backup_coolify() {
  log "=== Coolify Instance Backup ==="

  local coolify_dir="${COOLIFY_DATA_DIR}"
  if [ ! -d "${coolify_dir}" ]; then
    warn "Coolify data directory not found: ${coolify_dir}"
    return 1
  fi

  local backup_file="${BACKUP_DIR}/coolify-instance-$(date +%Y%m%d-%H%M%S).tar.gz"

  # Capture environment variables (APP_KEY etc.) BEFORE tar
  local env_file="${coolify_dir}/source/.env"
  local env_backup="${BACKUP_DIR}/coolify-env-$(date +%Y%m%d-%H%M%S).env"
  if [ -f "${env_file}" ]; then
    cp "${env_file}" "${env_backup}"
    log "Backed up .env to ${env_backup}"
    warn "CRITICAL: Store this .env file securely! It contains APP_KEY needed for restore."
  else
    warn "Coolify .env not found at ${env_file} - backups may not be restorable!"
  fi

  # Backup the entire Coolify data directory
  log "Backing up Coolify data directory: ${coolify_dir}"
  tar -czf "${backup_file}" -C "$(dirname "${coolify_dir}")" "$(basename "${coolify_dir}")" 2>/dev/null || {
    err "Failed to create Coolify backup archive"
    return 1
  }

  log "Coolify backup created: ${backup_file}"

  # Upload to OCI
  s3_upload "${backup_file}" "coolify/instance/$(basename "${backup_file}")"

  return 0
}

# ---------------------------------------------------------------------------
# 2. Database Backups
# =============================================================================
backup_databases() {
  log "=== Database Backups ==="

  local dbs_dir="${BACKUP_DIR}/databases"
  mkdir -p "${dbs_dir}"

  # Detect running Docker containers that look like databases
  if command -v docker &>/dev/null && docker info >/dev/null 2>&1; then
    local containers
    containers=$(docker ps --format '{{.Names}}' 2>/dev/null || true)

    for container in $containers; do
      local image
      image=$(docker inspect --format='{{.Image}}' "$container" 2>/dev/null || echo "")

      # PostgreSQL
      if echo "$image" | grep -qi 'postgres'; then
        backup_postgres "$container" "${dbs_dir}"
      fi

      # MySQL/MariaDB
      if echo "$image" | grep -qi 'mysql\|mariadb'; then
        backup_mysql "$container" "${dbs_dir}"
      fi

      # MongoDB
      if echo "$image" | grep -qi 'mongo'; then
        backup_mongo "$container" "${dbs_dir}"
      fi
    done
  else
    warn "Docker not available - skipping container database backups"
  fi
}

backup_postgres() {
  local container="$1"
  local out_dir="$2"
  local db_name="${POSTGRES_DB:-postgres}"
  local db_user="${POSTGRES_USER:-postgres}"
  local out_file="${dbs_dir}/postgres-${db_name}-$(date +%Y%m%d-%H%M%S).sql.gz"

  log "Backing up PostgreSQL: ${container} (${db_name})"

  if docker exec "${container}" pg_dumpall -U "${db_user}" 2>/dev/null | gzip > "${out_file}"; then
    log "PostgreSQL backup: ${out_file}"
    s3_upload "${out_file}" "coolify/databases/postgres/$(basename "${out_file}")"
  else
    err "Failed to dump PostgreSQL: ${container}"
  fi
}

backup_mysql() {
  local container="$1"
  local out_dir="$2"
  local db_name="${MYSQL_DATABASE:-mysql}"
  local db_user="${MYSQL_USER:-root}"
  local db_pass="${MYSQL_PASSWORD:-}"
  local out_file="${dbs_dir}/mysql-${db_name}-$(date +%Y%m%d-%H%M%S).sql.gz"

  log "Backing up MySQL/MariaDB: ${container} (${db_name})"

  local auth_opts=""
  if [ -n "${db_pass}" ]; then
    auth_opts="-p${db_pass}"
  fi

  if docker exec "${container}" mysqldump -u "${db_user}" ${auth_opts} --all-databases 2>/dev/null | gzip > "${out_file}"; then
    log "MySQL backup: ${out_file}"
    s3_upload "${out_file}" "coolify/databases/mysql/$(basename "${out_file}")"
  else
    err "Failed to dump MySQL: ${container}"
  fi
}

backup_mongo() {
  local container="$1"
  local out_dir="$2"
  local out_file="${dbs_dir}/mongodb-$(date +%Y%m%d-%H%M%S).gz"

  log "Backing up MongoDB: ${container}"

  if docker exec "${container}" mongodump --archive --gzip 2>/dev/null > "${out_file}"; then
    log "MongoDB backup: ${out_file}"
    s3_upload "${out_file}" "coolify/databases/mongodb/$(basename "${out_file}")"
  else
    err "Failed to dump MongoDB: ${container}"
  fi
}

# ---------------------------------------------------------------------------
# 4. Docker Volume Backups
# =============================================================================
backup_volumes() {
  log "=== Docker Volume Backups ==="

  if ! command -v docker &>/dev/null || ! docker info >/dev/null 2>&1; then
    warn "Docker not available - skipping volume backups"
    return 1
  fi

  local volumes_dir="${BACKUP_DIR}/volumes"
  mkdir -p "${volumes_dir}"

  local volumes
  volumes=$(docker volume ls -q 2>/dev/null || true)

  if [ -z "$volumes" ]; then
    warn "No Docker volumes found"
    return 0
  fi

  for vol in $volumes; do
    local vol_file="${volumes_dir}/volume-${vol}-$(date +%Y%m%d-%H%M%S).tar.gz"
    log "Backing up Docker volume: ${vol}"

    if docker run --rm \
      -v "${vol}:/source:ro" \
      -v "${volumes_dir}:/backup" \
      alpine:latest \
      tar -czf "/backup/$(basename "${vol_file}")" -C /source . 2>/dev/null; then
      log "Volume backup: ${vol_file}"
      s3_upload "${vol_file}" "coolify/volumes/$(basename "${vol_file}")"
    else
      err "Failed to back up volume: ${vol}"
    fi
  done
}

# ---------------------------------------------------------------------------
# Main
# =============================================================================
main() {
  local mode="${1:-full}"

  echo "================================================================"
  echo "  Coolify Backup - $(date)"
  echo "================================================================"
  echo ""

  mkdir -p "${BACKUP_DIR}"

  check_prereqs || true

  case "${mode}" in
    all|"")
      backup_coolify
      backup_databases
      backup_volumes
      ;;
    databases|db)
      backup_databases
      ;;
    volumes|vol)
      backup_volumes
      ;;
    coolify|cf)
      backup_coolify
      ;;
    *)
      err "Unknown mode: ${mode}"
      echo "Usage: $0 [all|databases|volumes|coolify]"
      exit 1
      ;;
  esac

  # Cleanup old local backups
  log "Cleaning up local backups older than ${RETENTION_DAYS} days"
  find "${BACKUP_DIR%/*}" -name "*.tar.gz" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
  find "${BACKUP_DIR%/*}" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
  find "${BACKUP_DIR%/*}" -name "*.env" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true

  echo ""
  echo "================================================================"
  echo "  Backup Complete: $(date)"
  echo "  Location: ${BACKUP_DIR}"
  echo "================================================================"
}

main "$@"