export function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

// Health palette for load/pressure gauges. warn/crit are per-metric because
// "high" means different things: a CPU spiking to 100% is fine, RAM near full is not.
// Pass the literal 'network' as warn to get the blue active/idle palette instead.
export function colorFor(value, warn = 60, crit = 85) {
  if (value == null) return '#4b5260';
  if (warn === 'network') return value > 0 ? '#5aa8ff' : '#4b5260';
  if (value >= crit) return '#c75050';
  if (value >= warn) return '#d7ba69';
  return '#75bf72';
}

export function formatMbps(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}G`;
  if (value >= 10) return `${value.toFixed(0)}M`;
  if (value > 0) return `${value.toFixed(1)}M`;
  return '0M';
}

// When no live throughput metric is available (e.g. the switch has no per-port
// traffic exporter), show `fallback` instead of a perpetual "WAITING". Callers only
// reach this with an up link, so the default reads "LINK UP"; the port map passes the
// negotiated link speed so the column still carries real information.
export function formatPortRate(rx, tx, fallback = 'LINK UP') {
  if (!Number.isFinite(rx) && !Number.isFinite(tx)) return fallback;
  return `D ${formatMbps(rx)} / U ${formatMbps(tx)}`;
}

export function formatGbFromBytes(value) {
  if (!Number.isFinite(value)) return '--';
  return `${(value / 1024 / 1024 / 1024).toFixed(value >= 100 * 1024 ** 3 ? 0 : 1)}GB`;
}

export function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function diskUsedPercent(freeBytes, totalBytes, fallback) {
  if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
    return (1 - freeBytes / totalBytes) * 100;
  }
  return fallback;
}

export function smartLabel(value) {
  if (value == null) return 'SMART WAITING';
  return value === 1 ? 'SMART GOOD' : 'SMART ALERT';
}
