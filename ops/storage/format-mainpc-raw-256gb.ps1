param(
  [string]$DriveLetter = "D",
  [string]$Label = "MAINPC_256GB",
  [switch]$Proceed
)

$ErrorActionPreference = "Stop"

if (-not $Proceed) {
  throw "Refusing to format without -Proceed. This script erases the RAW 256GB Toshiba NVMe."
}

$disk = Get-Disk |
  Where-Object {
    $_.FriendlyName -like "*KXG50ZNV256G*" -and
    $_.PartitionStyle -eq "RAW" -and
    $_.Size -gt 200GB -and
    $_.Size -lt 300GB
  } |
  Select-Object -First 1

if (-not $disk) {
  throw "No matching RAW 256GB Toshiba NVMe was found. Aborting."
}

if (Get-Volume -DriveLetter $DriveLetter -ErrorAction SilentlyContinue) {
  throw "Drive letter $DriveLetter is already in use. Choose another letter."
}

Write-Host "Formatting disk $($disk.Number): $($disk.FriendlyName) as $DriveLetter`: ($Label)"

Initialize-Disk -Number $disk.Number -PartitionStyle GPT
$partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $DriveLetter
Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel $Label -Confirm:$false

Get-Volume -DriveLetter $DriveLetter |
  Select-Object DriveLetter,FileSystemLabel,FileSystem,HealthStatus,Size,SizeRemaining
