# Storage Remediation

This folder contains guarded scripts for correcting the current storage layout.

## Current Confirmed State

## Access

Proxmox host:
- Host: `root@192.168.1.12`
- Hostname: `AIWA`
- SSH identity: `C:\Users\carte\.ssh\id_ed25519_claude`
- Use `IdentitiesOnly=yes` because the SSH agent may not be running.

Example:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519_claude" -o IdentitiesOnly=yes root@192.168.1.12
```

Main PC:
- `WD_BLACK SN7100 2TB`: live Windows `C:` volume.
- `KXG50ZNV256G NVMe TOSHIBA 256GB`: installed, healthy, RAW, no drive letter.
- `WD_BLACK SN7100 1TB`: planned install, not currently visible.

Proxmox:
- `WD_BLACK SN770 2TB`: visible as `nvme0n1`.
- `Samsung_SSD_840_PRO_Series`: visible as `sda`, not mounted as an exported filesystem.
- `local-lvm`: Proxmox LVM-thin storage, not visible through normal `node_filesystem_*` metrics.

## Main PC 256GB NVMe

Run from an elevated PowerShell only after confirming the 256GB Toshiba should be erased:

```powershell
.\ops\storage\format-mainpc-raw-256gb.ps1 -DriveLetter D -Label MAINPC_256GB -Proceed
```

The script refuses to run unless it finds the expected RAW 256GB Toshiba NVMe.

## Proxmox Samsung SATA SSD

Requires root shell on the Proxmox host.

Dry/safe behavior:

```bash
bash mount-proxmox-samsung-sata.sh
```

If the disk has no partition or filesystem and should be erased/formatted:

```bash
FORMAT=1 MOUNT_POINT=/mnt/samsung-sata bash mount-proxmox-samsung-sata.sh
```

Once mounted, node_exporter should expose the mount through `node_filesystem_*`.

Current live mount:

- Device: `/dev/sda2`
- Filesystem: `ntfs3`
- Mount: `/mnt/samsung-sata`
- Use: backup/archive/media/transfer storage, not active VM/container storage.

## Samba Transfer Share

The Samsung SATA SSD exposes a dedicated Windows share:

- Windows path: `\\192.168.1.12\Proxmox`
- Windows mapped drive: `M:`
- Linux path: `/mnt/samsung-sata/mav-transfer`
- Samba user: `mavshare`
- Credentials are stored in Windows Credential Manager for `192.168.1.12`.

Share folders:

- `M:\archives`
- `M:\backups`
- `M:\media`
- `M:\transfers`

This share is intentionally limited to the transfer/archive folder instead of exposing the whole Proxmox filesystem.

## Syncthing Boundary

Syncthing is for PC ↔ Surface only.

Active Syncthing folders:

- `C:\Workspace\Shared`
- `C:\Workspace\Transfer`

Do not use Syncthing for PC ↔ Proxmox transfers. Use the Samba mapped drive `M:` for server transfers.

## Proxmox local-lvm Metrics

`local-lvm` is not a mounted filesystem, so node_exporter will not emit usage for it. Use a node_exporter textfile collector script:

```bash
mkdir -p /var/lib/node_exporter/textfile_collector
bash pve-storage-metrics.sh
```

Then configure node_exporter with:

```bash
--collector.textfile.directory=/var/lib/node_exporter/textfile_collector
```

Prometheus metrics emitted:
- `mav_pve_storage_active`
- `mav_pve_storage_size_bytes`
- `mav_pve_storage_used_bytes`
- `mav_pve_storage_avail_bytes`
