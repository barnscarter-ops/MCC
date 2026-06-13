#!/usr/bin/env node
/**
 * prometheus-sync.mjs
 * Scrapes all Prometheus metrics every 5s and upserts a single row
 * into the Supabase `metrics` table. Lets the Vercel frontend read
 * live homelab data via Supabase realtime instead of /api/query.
 *
 * PM2: added to ecosystem.config.cjs
 */

import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env — prefer SEO app's .env (has Supabase keys), fall back to local
const envPath = fs.existsSync(path.join(__dirname, '..', '.env'))
  ? path.join(__dirname, '..', '.env')
  : 'C:\\Workspace\\Active\\SEO-Agents-App\\.env';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://192.168.1.12:9090';
const LOCAL_SERVER_URL = process.env.MAV_LOCAL_SERVER_URL || 'http://127.0.0.1:3000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INTERVAL_MS = Number(process.env.PROM_SYNC_INTERVAL_MS) || 5000;
const NODE_ID = process.env.PROM_SYNC_NODE_ID || 'homelab';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// All PromQL queries — mirror of src/config/metrics.js
const PROM_QUERIES = {
  pcCpu: '100 - (avg(rate(windows_cpu_time_total{job="main_pc",mode="idle"}[1m])) * 100)',
  pcRam: '(1 - windows_memory_physical_free_bytes{job="main_pc"} / windows_memory_physical_total_bytes{job="main_pc"}) * 100',
  pcRamUsedBytes: 'windows_memory_physical_total_bytes{job="main_pc"} - windows_memory_physical_free_bytes{job="main_pc"}',
  pcRamTotalBytes: 'windows_memory_physical_total_bytes{job="main_pc"}',
  pcGpu: 'max(nvidia_smi_utilization_gpu_ratio * 100)',
  pcGpuMemUsedBytes: 'max(nvidia_smi_memory_used_bytes)',
  pcGpuMemTotalBytes: 'max(nvidia_smi_memory_total_bytes)',
  pcDrive: '(1 - windows_logical_disk_free_bytes{job="main_pc",volume="C:"} / windows_logical_disk_size_bytes{job="main_pc",volume="C:"}) * 100',
  pcDriveCFreeBytes: 'windows_logical_disk_free_bytes{job="main_pc",volume="C:"}',
  pcDriveCTotalBytes: 'windows_logical_disk_size_bytes{job="main_pc",volume="C:"}',
  pcDriveCSmart: 'smartmon_device_smart_healthy{job=~"main_pc|smartctl",device=~".*SN7100.*|.*WD.*2T.*|.*C.*"}',
  pcDriveD: '(1 - windows_logical_disk_free_bytes{job="main_pc",volume="D:"} / windows_logical_disk_size_bytes{job="main_pc",volume="D:"}) * 100',
  pcDriveDFreeBytes: 'windows_logical_disk_free_bytes{job="main_pc",volume="D:"}',
  pcDriveDTotalBytes: 'windows_logical_disk_size_bytes{job="main_pc",volume="D:"}',
  pcDriveDSmart: 'smartmon_device_smart_healthy{job=~"main_pc|smartctl",device=~".*SN7100.*|.*WD.*256.*|.*D.*"}',
  pcNetIn: 'max(rate(windows_net_bytes_received_total{job="main_pc"}[1m]) * 8 / 1000 / 1000)',
  pcNetOut: 'max(rate(windows_net_bytes_sent_total{job="main_pc"}[1m]) * 8 / 1000 / 1000)',
  pcNetDirect: 'max(rate(windows_net_bytes_received_total{job="main_pc",interface="Ethernet 2"}[1m]) * 8 / 1000 / 1000)',
  serverNetSwitch: 'max(rate(node_network_receive_bytes_total{instance="192.168.1.12:9100",device="eth0"}[1m]) * 8 / 1000 / 1000)',
  serverNetDirect: 'max(rate(node_network_receive_bytes_total{instance="192.168.1.12:9100",device="eth1"}[1m]) * 8 / 1000 / 1000)',
  serverCpu: '100 - (avg by (instance) (rate(node_cpu_seconds_total{job="node_exporter",mode="idle"}[1m])) * 100)',
  serverRam: '(1 - (node_memory_MemAvailable_bytes{job="node_exporter"} / node_memory_MemTotal_bytes{job="node_exporter"})) * 100',
  rootDisk: '(1 - (node_filesystem_avail_bytes{job="node_exporter",mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{job="node_exporter",mountpoint="/",fstype!~"tmpfs|overlay"})) * 100',
  serverRootFreeBytes: 'node_filesystem_avail_bytes{job="node_exporter",mountpoint="/",fstype!~"tmpfs|overlay"}',
  serverRootTotalBytes: 'node_filesystem_size_bytes{job="node_exporter",mountpoint="/",fstype!~"tmpfs|overlay"}',
  dataDisk: '(1 - (node_filesystem_avail_bytes{job="node_exporter",mountpoint="/data",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{job="node_exporter",mountpoint="/data",fstype!~"tmpfs|overlay"})) * 100',
  pveLocalLvmFreeBytes: 'mav_pve_storage_avail_bytes{storage="local-lvm"}',
  pveLocalLvmTotalBytes: 'mav_pve_storage_size_bytes{storage="local-lvm"}',
  samsungSataFreeBytes: 'node_filesystem_avail_bytes{job="node_exporter",mountpoint="/mnt/samsung-sata",fstype!~"tmpfs|overlay"}',
  samsungSataTotalBytes: 'node_filesystem_size_bytes{job="node_exporter",mountpoint="/mnt/samsung-sata",fstype!~"tmpfs|overlay"}',
  pcUp: 'up{instance="192.168.1.10:9182"}',
  serverUp: 'up{instance="192.168.1.12:9100"}',
  wanDown: 'rate(att_broadband_ipv4_receive_bytes{job="bgw_exporter"}[1m]) * 8 / 1000 / 1000 / 1000',
  wanUp: 'rate(att_broadband_ipv4_transmit_bytes{job="bgw_exporter"}[1m]) * 8 / 1000 / 1000 / 1000',
  switchPort1Rx: 'netgear_switch_port_rx_mbps{port="1"}',
  switchPort1Tx: 'netgear_switch_port_tx_mbps{port="1"}',
  switchPort2Rx: 'netgear_switch_port_rx_mbps{port="2"}',
  switchPort2Tx: 'netgear_switch_port_tx_mbps{port="2"}',
  switchPort3Rx: 'netgear_switch_port_rx_mbps{port="3"}',
  switchPort3Tx: 'netgear_switch_port_tx_mbps{port="3"}',
  switchPort24Rx: 'rate(att_broadband_ipv4_receive_bytes{job="bgw_exporter"}[1m]) * 8 / 1000 / 1000',
  switchPort24Tx: 'rate(att_broadband_ipv4_transmit_bytes{job="bgw_exporter"}[1m]) * 8 / 1000 / 1000',
};

async function queryPrometheus(query) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const json = await res.json();
  const result = json?.data?.result;
  if (!Array.isArray(result) || result.length === 0) return null;
  const raw = result[0]?.value?.[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function scrapeAll() {
  const entries = Object.entries(PROM_QUERIES);
  const values = {};
  // Batch 6 at a time to stay well under Prometheus connection limits
  const concurrency = 6;
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(([key, query]) => queryPrometheus(query).then(v => [key, v]))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const [key, val] = r.value;
        values[key] = val;
      }
    }
  }
  return values;
}

async function fetchLocalJson(path) {
  try {
    const res = await fetch(`${LOCAL_SERVER_URL}${path}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function syncNodeStatus() {
  const [model_status, deploy_status, orchestrator_status] = await Promise.all([
    fetchLocalJson('/api/llm/status'),
    fetchLocalJson('/api/deploy/status'),
    fetchLocalJson('/api/orchestrator/status'),
  ]);

  // Only upsert if at least one endpoint responded
  if (!model_status && !deploy_status && !orchestrator_status) return;

  const { error } = await supabase
    .from('node_status')
    .upsert({
      node_id: NODE_ID,
      ...(model_status && { model_status }),
      ...(deploy_status && { deploy_status }),
      ...(orchestrator_status && { orchestrator_status }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'node_id' });

  if (error) console.error(`[prometheus-sync] node_status upsert error: ${error.message}`);
}

let consecutiveErrors = 0;
let statusTick = 0;

async function sync() {
  try {
    const values = await scrapeAll();
    const { error } = await supabase
      .from('metrics')
      .upsert({ node_id: NODE_ID, values, updated_at: new Date().toISOString() }, { onConflict: 'node_id' });
    if (error) throw error;
    consecutiveErrors = 0;
  } catch (err) {
    consecutiveErrors++;
    if (consecutiveErrors === 1 || consecutiveErrors % 12 === 0) {
      console.error(`[prometheus-sync] metrics error (x${consecutiveErrors}): ${err.message}`);
    }
  }

  // Sync node status every 3 ticks (every ~15s) — no need for sub-5s updates
  statusTick++;
  if (statusTick % 3 === 0) syncNodeStatus().catch(() => {});
}

console.log(`[prometheus-sync] starting — ${PROMETHEUS_URL} + ${LOCAL_SERVER_URL} → Supabase every ${INTERVAL_MS}ms`);
sync();
setInterval(sync, INTERVAL_MS);
