#!/usr/bin/env bash
set -euo pipefail

MOUNT_POINT="${MOUNT_POINT:-/mnt/samsung-sata}"
LABEL="${LABEL:-SAMSUNG_SATA}"
DISK_SERIAL="${DISK_SERIAL:-S1AXNEAD902572A}"
FORMAT="${FORMAT:-0}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root on the Proxmox host." >&2
  exit 1
fi

disk_path="$(find /dev/disk/by-id -maxdepth 1 -type l | grep -F "$DISK_SERIAL" | grep -v -- '-part' | head -n 1 || true)"
if [[ -z "$disk_path" ]]; then
  echo "Samsung SATA disk with serial $DISK_SERIAL was not found." >&2
  exit 1
fi

partition_path="$(find /dev/disk/by-id -maxdepth 1 -type l | grep -F "$DISK_SERIAL" | grep -- '-part1$' | head -n 1 || true)"

if [[ -z "$partition_path" ]]; then
  if [[ "$FORMAT" != "1" ]]; then
    echo "Disk has no partition. Re-run with FORMAT=1 only if you intend to erase and format it." >&2
    exit 1
  fi
  parted -s "$disk_path" mklabel gpt
  parted -s "$disk_path" mkpart primary ext4 0% 100%
  partprobe "$disk_path"
  sleep 2
  partition_path="$(find /dev/disk/by-id -maxdepth 1 -type l | grep -F "$DISK_SERIAL" | grep -- '-part1$' | head -n 1 || true)"
fi

if [[ -z "$partition_path" ]]; then
  echo "Partition was not found after probing." >&2
  exit 1
fi

fs_type="$(blkid -o value -s TYPE "$partition_path" 2>/dev/null || true)"
if [[ -z "$fs_type" ]]; then
  if [[ "$FORMAT" != "1" ]]; then
    echo "Partition has no filesystem. Re-run with FORMAT=1 only if you intend to erase and format it." >&2
    exit 1
  fi
  mkfs.ext4 -F -L "$LABEL" "$partition_path"
fi

mkdir -p "$MOUNT_POINT"
uuid="$(blkid -o value -s UUID "$partition_path")"

if ! grep -q "UUID=$uuid" /etc/fstab; then
  printf "UUID=%s %s ext4 defaults,nofail 0 2\n" "$uuid" "$MOUNT_POINT" >> /etc/fstab
fi

mount "$MOUNT_POINT"
df -hT "$MOUNT_POINT"
