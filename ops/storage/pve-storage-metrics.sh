#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${OUT_DIR:-/var/lib/node_exporter/textfile_collector}"
OUT_FILE="$OUT_DIR/pve_storage.prom"
TMP_FILE="$(mktemp)"

mkdir -p "$OUT_DIR"

pvesm status | awk '
  NR > 1 {
    name=$1
    type=$2
    status=$3
    total=$4 * 1024
    used=$5 * 1024
    avail=$6 * 1024
    active=(status == "active") ? 1 : 0
    gsub(/[^A-Za-z0-9_:-]/, "_", name)
    printf "mav_pve_storage_active{storage=\"%s\",type=\"%s\"} %d\n", name, type, active
    printf "mav_pve_storage_size_bytes{storage=\"%s\",type=\"%s\"} %.0f\n", name, type, total
    printf "mav_pve_storage_used_bytes{storage=\"%s\",type=\"%s\"} %.0f\n", name, type, used
    printf "mav_pve_storage_avail_bytes{storage=\"%s\",type=\"%s\"} %.0f\n", name, type, avail
  }
' > "$TMP_FILE"

mv "$TMP_FILE" "$OUT_FILE"
chmod 0644 "$OUT_FILE"
