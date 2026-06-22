import { describe, it, expect } from 'vitest';
import {
  clampPercent,
  colorFor,
  formatMbps,
  formatPortRate,
  formatGbFromBytes,
  formatCompactNumber,
  diskUsedPercent,
  smartLabel,
} from './format';

describe('clampPercent', () => {
  it('returns the value clamped between 0 and 100', () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });

  it('returns 0 for non-finite values', () => {
    expect(clampPercent(NaN)).toBe(0);
    expect(clampPercent(Infinity)).toBe(0);
    expect(clampPercent(-Infinity)).toBe(0);
  });
});

describe('colorFor', () => {
  it('returns gray for null/undefined', () => {
    expect(colorFor(null)).toBe('#4b5260');
    expect(colorFor(undefined)).toBe('#4b5260');
  });

  it('returns blue for positive network values, gray for zero', () => {
    expect(colorFor(100, 'network')).toBe('#5aa8ff');
    expect(colorFor(0, 'network')).toBe('#4b5260');
  });

  it('returns correct colors by threshold', () => {
    expect(colorFor(90)).toBe('#c75050');
    expect(colorFor(75)).toBe('#d7ba69');
    expect(colorFor(30)).toBe('#75bf72');
  });

  it('respects per-gauge warn/crit thresholds', () => {
    // RAM scale (80/92): 62% is healthy green, not the default-scale yellow.
    expect(colorFor(62, 80, 92)).toBe('#75bf72');
    expect(colorFor(85, 80, 92)).toBe('#d7ba69');
    expect(colorFor(95, 80, 92)).toBe('#c75050');
    // CPU scale (85/95): a busy 75% stays green.
    expect(colorFor(75, 85, 95)).toBe('#75bf72');
    expect(colorFor(90, 85, 95)).toBe('#d7ba69');
  });
});

describe('formatMbps', () => {
  it('returns "--" for non-finite values', () => {
    expect(formatMbps(NaN)).toBe('--');
    expect(formatMbps(Infinity)).toBe('--');
  });

  it('formats values >= 1000 as Gbps', () => {
    expect(formatMbps(1500)).toBe('1.5G');
    expect(formatMbps(10000)).toBe('10G');
  });

  it('formats values < 1000 as Mbps', () => {
    expect(formatMbps(500)).toBe('500M');
    expect(formatMbps(5.5)).toBe('5.5M');
    expect(formatMbps(0)).toBe('0M');
  });
});

describe('formatPortRate', () => {
  it('falls back when both values are non-finite', () => {
    expect(formatPortRate(NaN, NaN)).toBe('LINK UP');                    // default fallback
    expect(formatPortRate(NaN, NaN, '2.5 Gb link')).toBe('2.5 Gb link'); // custom fallback
    expect(formatPortRate(0, 0)).not.toBe('LINK UP');                    // zero is live data, not a fallback
  });

  it('formats rx/tx rates correctly', () => {
    expect(formatPortRate(500, 1200)).toBe('D 500M / U 1.2G');
  });
});

describe('formatGbFromBytes', () => {
  it('returns "--" for non-finite values', () => {
    expect(formatGbFromBytes(NaN)).toBe('--');
  });

  it('formats bytes to GB', () => {
    expect(formatGbFromBytes(1073741824)).toContain('1.0GB');
    expect(formatGbFromBytes(2147483648)).toContain('2.0GB');
  });
});

describe('formatCompactNumber', () => {
  it('returns "--" for non-finite values', () => {
    expect(formatCompactNumber(NaN)).toBe('--');
  });

  it('formats numbers with K, M, B suffixes', () => {
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(2500000)).toBe('2.5M');
    expect(formatCompactNumber(3500000000)).toBe('3.5B');
    expect(formatCompactNumber(42)).toBe('42');
  });
});

describe('diskUsedPercent', () => {
  it('calculates used percentage correctly', () => {
    expect(diskUsedPercent(50, 100, 0)).toBe(50);
    expect(diskUsedPercent(0, 100, 0)).toBe(100);
    expect(diskUsedPercent(100, 100, 0)).toBe(0);
  });

  it('returns fallback for invalid inputs', () => {
    expect(diskUsedPercent(NaN, 100, -1)).toBe(-1);
    expect(diskUsedPercent(50, 0, -1)).toBe(-1);
  });
});

describe('smartLabel', () => {
  it('returns SMART GOOD for value 1', () => {
    expect(smartLabel(1)).toBe('SMART GOOD');
  });

  it('returns SMART ALERT for other values', () => {
    expect(smartLabel(0)).toBe('SMART ALERT');
    expect(smartLabel(5)).toBe('SMART ALERT');
  });

  it('returns SMART WAITING for null', () => {
    expect(smartLabel(null)).toBe('SMART WAITING');
    expect(smartLabel(undefined)).toBe('SMART WAITING');
  });
});