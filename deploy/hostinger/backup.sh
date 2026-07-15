#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

docker run --rm \
  -v barakat_barakat_storage:/var/data:ro \
  -v "$PWD/$BACKUP_DIR:/backup" \
  alpine sh -c "cd /var/data && tar czf /backup/barakat-helpdesk-$STAMP.tar.gz ."

echo "Backup created: $BACKUP_DIR/barakat-helpdesk-$STAMP.tar.gz"
