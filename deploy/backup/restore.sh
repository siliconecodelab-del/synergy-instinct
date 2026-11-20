#!/bin/bash
# =============================================================================
# Coolify Restore Script
# =============================================================================
# Restores Coolify from backups created by backup-all.sh.
#
# Usage:
#   ./restore.sh <backup-tarball-or-directory>
#
# Examples:
#   ./restore.sh /tmp/coolify-backup-20261120-120000/coolify-instance-20261120-120000.tar.gz
#   ./restore.sh /tmp/coolify-backup-20261120-120000/databases/postgres-postgres-20261120-120000.sql.gz
#
# Environment variables:
#   COOLIFY_DATA_DIR    - Target Coolify data dir (default: /data/coolify)
#   OCI_OBJECT_STORAGE_* - Same as backup script (for downloading from OCI)
#
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/backup-common.sh" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COOLIFY_DATA_DIR="${COOLIFY_DATA_DIR:-/data/coolify}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Download from OCI if needed
# ---------------------------------------------------------------------------
download_from_oci() {
  local remote_key="$1"
  local local_file="$2"

  if [ -z "$OCI_ENDPOINT" ] || [ -z "$OCI_BUCKET" ]; then
    err "OCI credentials not configured - cannot download from Object Storage"
    return 1
  fi

  log "Downloading from OCI: ${remote_key}"
  AWS_ACCESS_KEY_ID="$OCI_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$OCI_SECRET_KEY" \
    AWS_ENDPOINT_URL="${OCI_ENDPOINT}" \
    aws s3 cp "s3://${OCI_BUCKET}/${remote_key}" "${local_file}" --no-progress 2>/dev/null || {
    err "Failed to download ${remote_key} from OCI Object Storage"
    return 1
  fi
  log "Downloaded: ${local_file}"
}

# ---------------------------------------------------------------------------
# Restore Coolify Instance
# =============================================================================
restore_coolify() {
  local tarball="$1"

  if [ ! -f "${tarball}" ]; then
    err "Coolify tarball not found: ${tarball}"
    return 1
  fi

  local coolify_dir="${COOLIFY_DATA_DIR}"
  mkdir -p "${coolify_dir}"

  log "Stopping Coolify services..."
  docker compose -f /data/coolify/docker-compose.yml stop 2>/dev/null || \
    docker compose -f /opt/coolify/docker-compose.yml stop 2>/dev/null || \
    warn "Could not stop Coolify via docker-compose - manual stop may be required"

  log "Extracting Coolify backup to ${coolify_dir}..."
  tar -xzf "${tarball}" -C "${coolify_dir}/.." 2>/dev/null || {
    err "Failed to extract Coolify backup"
    return 1
  }

  log "Coolify data restored to ${coolify_dir}"
  log "START Coolify with: docker compose -f /data/coolify/docker-compose.yml up -d"
}

# ---------------------------------------------------------------------------
# Restore Database
# =============================================================================
restore_database() {
  local dump_file="$1"
  local target_container="$2"

  if [ ! -f "${dump_file}" ]; then
    err "Backup file not found: ${dump_file}"
    return 1
  fi

  if [ -z "${target_container}" ]; then
    err "Target container name required for database restore"
    return 1
  fi

  if echo "${dump_file}" | grep -qi 'postgres'; then
    log "Restoring PostgreSQL to ${target_container}..."
    gunzip -c "${dump_file}" | docker exec -i "${target_container}" psql -U postgres 2>/dev/null || {
      err "Failed to restore PostgreSQL to ${target_container}"
      return 1
    }
    log "PostgreSQL restored to ${target_container}"

  elif echo "${dump_file}" | grep -qi 'mysql'; then
    log "Restoring MySQL/MariaDB to ${target_container}..."
    gunzip -c "${dump_file}" | docker exec -i "${target_container}" mysql -u root 2>/dev/null || {
      err "Failed to restore MySQL to ${target_container}"
      return 1
    }
    log "MySQL restored to ${target_container}"

  elif echo "${dump_file}" | grep -qi 'mongodb'; then
    log "Restoring MongoDB to ${target_container}..."
    gunzip -c "${dump_file}" | docker exec -i "${target_container}" mongorestore --archive --gzip 2>/dev/null || {
      err "Failed to restore MongoDB to ${target_container}"
      return 1
    }
    log "MongoDB restored to ${target_container}"

  else
    err "Unknown database type for file: ${dump_file}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Restore Docker Volume
# =============================================================================
restore_volume() {
  local tarball="$1"
  local volume_name="$2"

  if [ ! -f "${tarball} ]; then
    err "Volume tarball not found: ${tarball}"
    return 1
  fi

  if [ -z "${volume_name}" ]; then
    err "Volume name required for volume restore"
    return 1
  fi

  log "Restoring Docker volume: ${volume_name}"

  docker run --rm \
    -v "${volume_name}:/target:rw" \
    -v "$(dirname "${tarball}"):/backup:ro" \
    alpine:latest \
    tar -xzf "/backup/$(basename "${tarball}")" -C /target 2>/dev/null || {
    err "Failed to restore volume: ${volume_name}"
    return 1
  }

  log "Volume restored: ${volume_name}"
}

# ---------------------------------------------------------------------------
# Main
# =============================================================================
main() {
  local target="$1"

  if [ -z "${target}" ]; then
    echo "Usage: $0 <backup-file-or-directory>"
    echo ""
    echo "Examples:"
    echo "  $0 /tmp/coolify-backup-20261120-120000/coolify-instance-*.tar.gz"
    echo "  $0 /tmp/coolify-backup-20261120-120000/databases/postgres-*.sql.gz"
    echo "  $0 /tmp/coolify-backup-20261120-120000/volumes/volume-*.tar.gz"
    exit 1
  fi

  # If it's a remote OCI path, download first
  if [[ "${target}" == s3://* ]] || [[ "${target}" == http* ]]; then
    local local_file="${BACKUP_DIR:-/tmp/coolify-restore}/$(basename "${target}")"
    mkdir -p "$(dirname "${local_file}")"
    download_from_oci "${target#s3://}" "${local_file}"
    target="${local_file}"
  fi

  if [ ! -f "${target}" ]; then
    err "File not found: ${target}"
    exit 1
  fi

  # Determine what to restore based on path/name
  if echo "${target}" | grep -qi 'coolify-instance'; then
    restore_coolify "${target}"
  elif echo "${target}" | grep -qiE 'postgres|mysql|mongo|mongodb'; then
    err "Database restore requires target container: $0 <file> <container-name>"
    exit 1
  elif echo "${target}" | grep -qi 'volume'; then
    err "Volume restore requires volume name: $0 <file> <volume-name>"
    exit 1
  else
    err "Unknown backup type: ${target}"
    exit 1
  fi

  log "Restore complete. Remember to restart your services."
}

main "$@"