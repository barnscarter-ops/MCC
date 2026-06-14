import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as echarts from 'echarts';
import { useDeployStatus, useMetrics, useModelStatus, useOrchestratorStatus, useSeoWorkflow } from './hooks/useMetrics.js';
import {
  approveSeoAction,
  createLocalWorkerBrief,
  createOrchestratorPlan,
  createTaskRun,
  queryMemory,
  querySeoActions,
  runSeoAction,
  updateTaskRun
} from './lib/api.js';
import {
  clampPercent,
  colorFor,
  diskUsedPercent,
  formatCompactNumber,
  formatGbFromBytes,
  formatMbps,
  formatPortRate,
  smartLabel
} from './lib/format.js';
import SEOApprovalPage from './SEOApprovalPage.jsx';
import { isDocumentResponse, MavMarkdown } from './mavUtils.js';
import './styles.css';

function Gauge({ label, value, sublabel, color, max = 100, unit = '%', compact = false, valueText = null, decimals = 0 }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const safeValue = value == null ? 0 : Number(value);
  const displayValue = valueText ?? (value == null ? 'N/A' : safeValue.toFixed(decimals));
  const accent = color || colorFor(safeValue);

  useEffect(() => {
    if (!ref.current) return undefined;
    chartRef.current = echarts.init(ref.current, null, { renderer: 'canvas' });
    const resize = () => chartRef.current?.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const ratioValue = value == null ? 0 : Math.max(0, Math.min(max, safeValue));
    chartRef.current.setOption({
      animationDuration: 500,
      series: [
        {
          type: 'gauge',
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max,
          radius: '96%',
          center: ['50%', '53%'],
          splitNumber: 4,
          progress: {
            show: true,
            roundCap: true,
            width: compact ? 8 : 11,
            itemStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 1,
                y2: 0,
                colorStops: [
                  { offset: 0, color: accent },
                  { offset: 1, color: '#f1f7ff' }
                ]
              },
              shadowBlur: 8,
              shadowColor: accent
            }
          },
          axisLine: {
            roundCap: true,
            lineStyle: { width: compact ? 8 : 11, color: [[1, '#2b2f39']] }
          },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          pointer: { show: false },
          anchor: { show: false },
          detail: { show: false },
          data: [{ value: ratioValue }]
        }
      ]
    });
  }, [accent, compact, max, safeValue, value]);

      return (
    <div className="gaugeShell">
      <div ref={ref} className="gaugeChart" />
      <div className="gaugeValue" style={{ color: accent }}>
        {displayValue}
        {valueText == null && value != null ? unit : ''}
      </div>
      <div className="gaugeLabel">{label}</div>
      {sublabel ? <div className="gaugeSub">{sublabel}</div> : null}
    </div>
  );
}

function Panel({ title, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {title ? <div className="panelTitle">{title}</div> : null}
      {children}
    </section>
  );
}

function formatFullRate(mbps) {
  if (!Number.isFinite(mbps)) return 'WAITING';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gb/s`;
  if (mbps >= 10) return `${mbps.toFixed(0)} Mb/s`;
  if (mbps > 0) return `${mbps.toFixed(1)} Mb/s`;
  return '0 Mb/s';
}

function formatWanDown(metrics) {
  const portDown = Number(metrics.switchPort24Rx);
  if (Number.isFinite(portDown) && portDown > 0) return formatFullRate(portDown);
  const wanDown = Number(metrics.wanDown);
  if (Number.isFinite(wanDown)) return formatFullRate(wanDown * 1000);
  return 'WAITING';
}

function formatPcUpDown(metrics) {
  const down = Number.isFinite(metrics.switchPort3Rx) ? metrics.switchPort3Rx : metrics.pcNetIn;
  const up = Number.isFinite(metrics.switchPort3Tx) ? metrics.switchPort3Tx : metrics.pcNetOut;
  return `D ${formatMbps(down)} / U ${formatMbps(up)}`;
}

function compactModelName(name) {
  if (!name) return 'NO MODEL';
  return name.replace(/^qwen/i, 'Qwen').replace(/-/g, ' ');
}

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
  )},
  { id: 'hardware', label: 'Hardware', icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
  )},
  { id: 'network', label: 'Network', icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><circle cx="12" cy="5" r="3"/><circle cx="4" cy="19" r="3"/><circle cx="20" cy="19" r="3"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="13" x2="4" y2="16"/><line x1="12" y1="13" x2="20" y2="16"/></svg>
  )},
  { id: 'orchestrator', label: 'Orchestrator', icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  )},
  { id: 'seo', label: 'SEO Pipeline', icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
  ), badge: true },
];

function Sidebar({ status, modelStatus }) {
  const [view, setView] = useDashboardView();
  const deployStatus = useDeployStatus();
  const deployOk = deployStatus.state === 'ok';
  const time = useMemo(() => {
    const now = status.updatedAt || new Date();
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(now);
  }, [status.updatedAt]);

  return (
    <aside className="sidebar">
      <div className="sidebarLogo">
        <img src="/assets/maverick-core-commander-logo.png" alt="Maverick Core Commander" className="sidebarLogoImg" />
        <span className="sidebarLogoCollapsed">M</span>
      </div>

      <nav className="sidebarNav" aria-label="Dashboard view">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`sidebarNavItem${view === item.id ? ' active' : ''}`}
            onClick={() => setView(item.id)}
          >
            <span className="sidebarNavIcon">{item.icon}</span>
            <span className="sidebarNavLabel">{item.label}</span>
            {item.badge && <span className="sidebarNavBadge" />}
          </button>
        ))}
      </nav>

      <div className="sidebarFooter">
        <div className="sidebarSystemStatus">
          <div className={`sidebarStatusRow ${status.state === 'online' ? 'online' : 'offline'}`}>
            <span className="sidebarStatusDot" />
            <div className="sidebarStatusInfo">
              <span className="sidebarStatusLabel">PROMETHEUS</span>
              <span className="sidebarStatusValue">{time}</span>
            </div>
          </div>
          <div className={`sidebarStatusRow ${modelStatus.state === 'online' ? 'online' : 'offline'}`}>
            <span className="sidebarStatusDot" />
            <div className="sidebarStatusInfo">
              <span className="sidebarStatusLabel">LOCAL MODEL</span>
              <span className="sidebarStatusValue">{compactModelName(modelStatus.model)}</span>
            </div>
          </div>
          <div className={`sidebarStatusRow ${deployOk ? 'online' : 'offline'}`}>
            <span className="sidebarStatusDot" />
            <div className="sidebarStatusInfo">
              <span className="sidebarStatusLabel">DEPLOY</span>
              <span className="sidebarStatusValue">{deployOk ? 'OK' : 'CHECKING…'}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

const DashboardViewContext = React.createContext(['home', () => {}]);

function useDashboardView() {
  return React.useContext(DashboardViewContext);
}

function Workstation({ metrics }) {
  const ramUsed = formatGbFromBytes(metrics.pcRamUsedBytes);
  const ramTotal = formatGbFromBytes(metrics.pcRamTotalBytes);
  const driveCUsed = diskUsedPercent(metrics.pcDriveCFreeBytes, metrics.pcDriveCTotalBytes, metrics.pcDrive);
  return (
    <Panel title="WORKSTATION: INTEL i5-13600K" className="workstation">
      <div className="gaugeRow pcGaugeRow">
        <Gauge label="CPU" value={metrics.pcCpu} sublabel="INTEL i5-13600K" />
        <Gauge
          label="GPU"
          value={metrics.pcGpu}
          sublabel="RTX 4060 Ti 16GB"
          color="#7da6d8"
        />
        <Gauge
          label="RAM"
          value={metrics.pcRam}
          sublabel={`${ramUsed} / ${ramTotal}`}
          color="#d9bf6f"
          decimals={1}
        />
      </div>
      <div className="hardwareSpecStrip">
        <div>
          <span>CPU</span>
          <strong>Intel i5-13600K</strong>
        </div>
        <div>
          <span>GPU</span>
          <strong>RTX 4060 Ti 16GB</strong>
        </div>
        <div>
          <span>BOARD</span>
          <strong>ASUS Z690</strong>
        </div>
        <div>
          <span>RAM</span>
          <strong>64GB DDR4</strong>
        </div>
      </div>
      <div className="driveGrid">
        <DriveBlock
          name="2TB WD-Black SN7100"
          mount="C: NVME"
          used={driveCUsed}
          freeBytes={metrics.pcDriveCFreeBytes}
          totalBytes={metrics.pcDriveCTotalBytes}
          healthText="HEALTHY"
        />
        <DriveBlock
          name="256GB Toshiba NVMe"
          mount="INSTALLED / RAW"
          totalBytes={256060514304}
          healthText="HEALTHY"
          note="No drive letter or filesystem yet"
        />
        <DriveBlock
          name="1TB WD-Black SN7100"
          mount="PLANNED / BOTTOM NVME"
          totalBytes={1000204886016}
          healthText="PENDING"
          note="Install pending tonight"
        />
      </div>
      <div className="panelFooter">
        <span className={metrics.pcUp === 1 ? 'ok' : 'bad'}>{metrics.pcUp === 1 ? 'EXPORTER ONLINE' : 'EXPORTER DOWN'}</span>
        <span>PORT 3 / 2.5Gb</span>
      </div>
    </Panel>
  );
}

function ModelOps({ metrics, modelStatus, orchestratorStatus }) {
  const gpuMemUsedGb = formatGbFromBytes(metrics.pcGpuMemUsedBytes);
  const gpuMemTotalGb = formatGbFromBytes(metrics.pcGpuMemTotalBytes);
  const gpuMemPercent = metrics.pcGpuMemUsedBytes && metrics.pcGpuMemTotalBytes
    ? (metrics.pcGpuMemUsedBytes / metrics.pcGpuMemTotalBytes) * 100
    : null;
  const modelOnline = modelStatus.state === 'online';
  const gpuLoad = metrics.pcGpu == null ? null : clampPercent(metrics.pcGpu);
  const runtimeState = !modelOnline
    ? 'OFFLINE'
    : gpuLoad != null && gpuLoad >= 10
      ? 'GENERATING'
      : 'LOADED / IDLE';
  const { evalSpeed, promptTokensTotal, outputTokensTotal, genSpeed } = modelStatus;
  const claudeWorker = (orchestratorStatus.workers || []).find((worker) => worker.id === 'claude-cli');
  const claudeState = claudeWorker?.state || 'loading';
  const claudeReady = /ready|online|available|manual/i.test(claudeState);
  const promptMetricsLive = modelStatus.promptMetricsSource && modelStatus.promptMetricsSource !== 'unavailable';
  const formatTokenMetric = (value) => value == null ? '--' : value.toLocaleString();
  const formatSpeedMetric = (value) => value == null ? '--' : `${Number(value).toFixed(1)} t/s`;

  return (
    <Panel title="LOCAL AI CORE" className="modelOps">
      <div className="modelOpsGrid">
        <div className={`modelState ${modelOnline ? 'online' : 'offline'} ${runtimeState === 'GENERATING' ? 'generating' : ''}`}>
          <span>MODEL</span>
          <strong>{compactModelName(modelStatus.model)}</strong>
          <em>{runtimeState}</em>
        </div>
        <Gauge
          label="GPU LOAD"
          value={metrics.pcGpu}
          sublabel="COMPUTE NOW"
          color="#7da6d8"
          compact
        />
        <Gauge
          label="VRAM ALLOCATED"
          value={gpuMemPercent}
          sublabel={`${gpuMemUsedGb} / ${gpuMemTotalGb}`}
          color="#d9bf6f"
          compact
          decimals={1}
        />
      </div>
      <div className="modelMetaGrid">
        <div>
          <span>CONTEXT</span>
          <strong>{modelStatus.contextTokens ? `${modelStatus.contextTokens.toLocaleString()} TOKENS` : 'WAITING'}</strong>
        </div>
        <div>
          <span>PARAMETERS</span>
          <strong>{formatCompactNumber(modelStatus.parameterCount)}</strong>
        </div>
        <div>
          <span>ENDPOINT</span>
          <strong>{modelStatus.endpoint || 'UNLINKED'}</strong>
        </div>
      </div>
      <div className="aiRuntimeGrid">
        <div className={`claudeMgrChip ${claudeReady ? 'ok' : claudeState === 'loading' ? 'loading' : 'offline'}`}>
          <span>CLAUDE MGR</span>
          <strong>{claudeReady ? 'READY' : claudeState.toUpperCase()}</strong>
          <em>PLANNER / QC</em>
        </div>
        <div className="promptMetaPanel">
          <div className="promptMetaGrid">
            <div>
              <span>EVAL</span>
              <strong>{formatSpeedMetric(evalSpeed)}</strong>
            </div>
            <div>
              <span>GEN</span>
              <strong>{formatSpeedMetric(genSpeed)}</strong>
            </div>
            <div>
              <span>PROMPT</span>
              <strong>{formatTokenMetric(promptTokensTotal)}</strong>
            </div>
            <div>
              <span>OUTPUT</span>
              <strong>{formatTokenMetric(outputTokensTotal)}</strong>
            </div>
          </div>
          <div className={`promptMetricStatus ${promptMetricsLive ? 'online' : 'offline'}`}>
            {promptMetricsLive ? 'LIVE LLAMA METRICS' : 'LLAMA METRICS OFF'}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function DriveBlock({ name, mount, used = null, freeBytes = null, totalBytes = null, smart = null, healthText = null, note = null }) {
  const safeUsed = used == null ? null : clampPercent(used);
  const statusText = healthText || smartLabel(smart);
  const statusClass = statusText === 'PENDING' ? 'pending' : smart === 0 ? 'bad' : statusText === 'HEALTHY' || smart === 1 ? 'ok' : '';
  const usedBytes = Number.isFinite(freeBytes) && Number.isFinite(totalBytes) ? totalBytes - freeBytes : null;
  return (
    <div className={`driveBlock ${safeUsed == null ? 'waiting' : ''}`}>
      <div className="driveHead">
        <span>{name}</span>
        <strong className={statusClass}>{statusText}</strong>
      </div>
      <div className="driveMeta">
        <em>{mount}</em>
        <b>{safeUsed == null ? 'WAITING' : `${Math.round(safeUsed)}% USED`}</b>
      </div>
      <div className="miniBar driveUsage"><i style={{ width: `${safeUsed ?? 0}%` }} /></div>
      <div className="driveStats">
        <span>{usedBytes == null ? 'USED --' : `USED ${formatGbFromBytes(usedBytes)}`}</span>
        <span>TOTAL {formatGbFromBytes(totalBytes)}</span>
      </div>
      {note ? <div className="driveNote">{note}</div> : null}
    </div>
  );
}

function SwitchGraphic() {
  const ports = Array.from({ length: 24 }, (_, index) => {
    const live = [0, 1, 2, 22].includes(index);
    return <span key={index} className={live ? 'port live' : 'port'} />;
  });
  return (
    <div className="switchGraphic">
      <div className="switchBrand">NETGEAR</div>
      <div className="portRail">{ports}</div>
      <div className="switchGlow" />
      <div className="switchLegend">
        <span>NETGEAR 10G SWITCH</span>
      </div>
      <div className="trafficArrows">
        <span>DOWN 2.5Gb</span>
        <span>LAN 10Gb</span>
        <span>UP 1Gb</span>
      </div>
    </div>
  );
}

function Network({ metrics }) {
  return (
    <Panel title="NETWORK MAP" className="network">
      <HardwareNetworkMap metrics={metrics} />
      <div className="networkStats">
        <div>
          <span>WAN DOWN</span>
          <strong>{formatWanDown(metrics)}</strong>
        </div>
        <div>
          <span>PC UP / DOWN</span>
          <strong>{formatPcUpDown(metrics)}</strong>
        </div>
      </div>
    </Panel>
  );
}

function HardwareNetworkMap({ metrics }) {
  const pcOnline = metrics.pcUp === 1;
  const serverOnline = metrics.serverUp === 1;
  const pcHealth = Math.max(clampPercent(metrics.pcCpu), clampPercent(metrics.pcRam), clampPercent(metrics.pcDrive));
  const serverHealth = Math.max(clampPercent(metrics.serverCpu), clampPercent(metrics.serverRam), clampPercent(metrics.rootDisk));
  const pcClass = pcHealth >= 85 ? 'danger' : pcHealth >= 60 ? 'warn' : 'good';
  const serverClass = serverHealth >= 85 ? 'danger' : serverHealth >= 60 ? 'warn' : 'good';
  const gatewayRate = formatWanDown(metrics);
  return (
    <div className="hardwareNetworkMapPanel">
      <div className="hardwareTopology">
        <svg className="hardwareLines" viewBox="0 0 560 154" preserveAspectRatio="none" aria-hidden="true">
          <path className="staticLink good" d="M70 0 L70 58" />
          <path className={`staticLink ${pcOnline ? pcClass : 'danger'}`} d="M210 0 L210 58" />
          <path className="staticLink good" d="M350 0 L350 58" />
          <path className={`staticLink ${serverOnline ? serverClass : 'danger'}`} d="M490 0 L490 58" />
          <path className="flowLink good" d="M70 0 L70 58" />
          <path className={`flowLink ${pcOnline ? pcClass : 'danger'}`} d="M210 0 L210 58" />
          <path className="flowLink good" d="M350 0 L350 58" />
          <path className={`flowLink ${serverOnline ? serverClass : 'danger'}`} d="M490 0 L490 58" />
        </svg>
        <span className="topoPort gatewayPort">24</span>
        <span className="topoPort pcPort">3</span>
        <span className="topoPort meshPort">2</span>
        <span className="topoPort serverPort">1</span>
        <div className="topoDevice gatewayDevice">
          <span>2.5Gb AT&amp;T Fiber Gateway</span>
          <strong>Port 24 / Main In</strong>
          <em>{gatewayRate} DOWN</em>
        </div>
        <div className={`topoDevice pcDevice ${pcOnline ? 'online' : 'offline'}`}>
          <span>Main Workstation</span>
          <strong>Port 3 / 2.5Gb</strong>
          <em>CPU {Math.round(clampPercent(metrics.pcCpu))}% / RAM {Math.round(clampPercent(metrics.pcRam))}%</em>
        </div>
        <div className="topoDevice meshDevice">
          <span>x25 Deco Mesh</span>
          <strong>Port 2 / 1Gb</strong>
          <em>Wireless Clients</em>
        </div>
        <div className={`topoDevice serverDevice ${serverOnline ? 'online' : 'offline'}`}>
          <span>HP ProDesk Server</span>
          <strong>Port 1 / 2.5Gb</strong>
          <em>CPU {Math.round(clampPercent(metrics.serverCpu))}% / RAM {Math.round(clampPercent(metrics.serverRam))}%</em>
        </div>
      </div>
      <div className="hardwarePortMap">
        {[
          ['24', 'AT&T Fiber Gateway', 'ACTIVE', formatPortRate(metrics.switchPort24Rx, metrics.switchPort24Tx)],
          ['1', 'HP ProDesk Server', serverOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx)],
          ['2', 'x25 Deco Mesh', 'ACTIVE', formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx)],
          ['3', 'Main Workstation', pcOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx)],
          ['4-22', 'Available', 'IDLE', '-']
        ].map(([port, device, state, rate]) => (
          <div className="hardwarePortRow" key={port}>
            <strong>{port}</strong>
            <span>{device}</span>
            <em className={state === 'DOWN' ? 'down' : ''}>{state}</em>
            <b>{rate}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function Server({ metrics }) {
  const serverOnline = Number(metrics.serverUp) === 1;
  return (
    <Panel title="HP ProDesk RAG SERVER (PROXMOX)" className="server">
      <div className="serverGrid">
        <div className={`statusOrb ${serverOnline ? 'online' : 'offline'}`}>
          <span>NODE</span>
          <strong>{serverOnline ? 'UP' : 'DOWN'}</strong>
        </div>
        <Gauge label="SERVER CPU" value={metrics.serverCpu} compact />
        <Gauge label="RAM" value={metrics.serverRam} compact color="#7da6d8" />
        <Gauge label="ROOT DISK" value={metrics.rootDisk} compact color="#7ac177" />
      </div>
      <div className="parseLine">
        <span>PROXMOX EXPORTER STATUS:</span>
        <strong>{serverOnline ? 'ONLINE' : 'OFFLINE'}</strong>
      </div>
      <div className="panelFooter">
        <span className={serverOnline ? 'ok' : 'bad'}>{serverOnline ? 'NODE_EXPORTER ONLINE' : 'NODE_EXPORTER DOWN'}</span>
        <span>PORT 1 / 2.5Gb</span>
      </div>
    </Panel>
  );
}

function Storage({ metrics }) {
  const root = clampPercent(metrics.rootDisk);
  const localLvmUsed = diskUsedPercent(metrics.pveLocalLvmFreeBytes, metrics.pveLocalLvmTotalBytes, null);
  const samsungSataUsed = diskUsedPercent(metrics.samsungSataFreeBytes, metrics.samsungSataTotalBytes, null);
  return (
    <Panel title="STORAGE AND HEALTH" className="storage">
      <div className="healthBar">
        <span>STORAGE SYSTEM HEALTH</span>
        <div>
          <i style={{ width: '98%' }} />
        </div>
        <strong>98% GOOD</strong>
      </div>
      <div className="storageGrid">
        <DriveBlock
          name="Proxmox Root"
          mount="/ on pve-root"
          used={root}
          freeBytes={metrics.serverRootFreeBytes}
          totalBytes={metrics.serverRootTotalBytes}
          healthText="LIVE"
          note="WD_BLACK SN770 2TB NVMe"
        />
        <DriveBlock
          name="Proxmox local-lvm"
          mount="LVM THIN / NVME"
          used={localLvmUsed}
          freeBytes={metrics.pveLocalLvmFreeBytes}
          totalBytes={metrics.pveLocalLvmTotalBytes}
          healthText={localLvmUsed == null ? 'PVE' : 'LIVE'}
          note="WD_BLACK SN770 2TB NVMe"
        />
        <DriveBlock
          name="Samsung 840 Pro SATA"
          mount="/mnt/samsung-sata"
          used={samsungSataUsed}
          freeBytes={metrics.samsungSataFreeBytes}
          totalBytes={metrics.samsungSataTotalBytes}
          healthText={samsungSataUsed == null ? 'INSTALLED' : 'LIVE'}
          note="Mounted NTFS / SMART passed"
        />
      </div>
    </Panel>
  );
}

function Services({ metrics }) {
  const pcOnline = metrics.pcUp === 1;
  const serverOnline = metrics.serverUp === 1;
  const services = [
    ['PROMETHEUS', 'ONLINE'],
    ['MAV-CONSOLE', 'ONLINE'],
    ['MAIN PC', pcOnline ? 'ONLINE' : 'DOWN'],
    ['PROXMOX', serverOnline ? 'ONLINE' : 'DOWN'],
    ['LOCAL MODEL', 'TRACKED']
  ];
  return (
    <Panel title="SERVICE MAP" className="services">
      <div className="serviceList">
        {services.map(([name, state]) => (
          <div className="serviceRow" key={name}>
            <span className={state === 'DOWN' ? 'led red' : 'led'} />
            <strong>{name}</strong>
            <em>{state}</em>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function NetworkMapPage({ metrics }) {
  const pcOnline = metrics.pcUp === 1;
  const serverOnline = metrics.serverUp === 1;
  const pcHealth = Math.max(clampPercent(metrics.pcCpu), clampPercent(metrics.pcRam), clampPercent(metrics.pcDrive));
  const serverHealth = Math.max(clampPercent(metrics.serverCpu), clampPercent(metrics.serverRam), clampPercent(metrics.rootDisk));
  const pcClass = pcHealth >= 85 ? 'danger' : pcHealth >= 60 ? 'warn' : 'good';
  const serverClass = serverHealth >= 85 ? 'danger' : serverHealth >= 60 ? 'warn' : 'good';
  const gatewayClass = metrics.wanDown > 0 || metrics.wanUp > 0 ? 'good' : 'good';
  const meshClass = 'good';
  const gatewayRate = formatWanDown(metrics);
  return (
    <div className="mapPage">
      <Panel title="LIVE NETWORK MAP" className="mapPanel">
        <div className="topologyCanvas">
          {/* Tier zone labels */}
          <div className="tierChip" style={{top: 12, left: 14}}>WAN / INTERNET</div>
          <div className="tierChip" style={{top: 374, left: 14}}>SWITCH CORE</div>
          <div className="tierChip" style={{top: 530, left: 14}}>ENDPOINTS</div>
          {/* Horizontal tier dividers */}
          <div className="tierDivider" style={{top: 362}} />
          <div className="tierDivider" style={{top: 518}} />
          {/* Link speed labels */}
          <div className="linkLabel" style={{top: 106, left: 'calc(50% + 120px)'}}>AT&T FIBER</div>
          <div className="linkLabel" style={{top: 230, left: 'calc(50% + 120px)'}}>WAN UPLINK</div>
          <div className="linkLabel" style={{top: 340, left: 'calc(50% + 120px)'}}>GW → CORE</div>
          <div className="linkLabel" style={{top: 487, left: '28%'}}>P3 · 2.5 Gb</div>
          <div className="linkLabel" style={{top: 487, left: 'calc(50% + 120px)'}}>P2 · 1 Gb</div>
          <div className="linkLabel" style={{top: 487, right: '14%'}}>P1 · 2.5 Gb</div>

          <div className="mapNode isp">
            <span className="nodeTypeBadge">PROVIDER</span>
            <span>2.5Gb AT&T Fiber</span>
            <strong>ISP LINK</strong>
          </div>
          <div className="mapNode internet">
            <span className="nodeTypeBadge">CLOUD</span>
            <span>Internet</span>
            <strong>WAN</strong>
          </div>
          <div className="mapNode router">
            <span className="nodeTypeBadge">GATEWAY</span>
            <span>Gateway Router</span>
            <strong>{gatewayRate} DOWN</strong>
          </div>
          <div className="mapNode switch">
            <span className="nodeTypeBadge">CORE SWITCH</span>
            <span>10Gb Network Switch</span>
            <strong>24 PORT</strong>
            <div className="mapPorts">
              {Array.from({ length: 24 }, (_, index) => (
                <i
                  key={index}
                  className={[
                    index === 23 ? `hot ${gatewayClass}` : '',
                    index === 0 ? `hot ${serverOnline ? serverClass : 'danger'}` : '',
                    index === 1 ? `hot ${meshClass}` : '',
                    index === 2 ? `hot ${pcOnline ? pcClass : 'danger'}` : ''
                  ].filter(Boolean).join(' ')}
                />
              ))}
            </div>
            <span className={`portAnchor port1 ${serverOnline ? serverClass : 'danger'}`} title="Port 1" />
            <span className={`portAnchor port2 ${meshClass}`} title="Port 2" />
            <span className={`portAnchor port3 ${pcOnline ? pcClass : 'danger'}`} title="Port 3" />
            <span className={`portAnchor port24 ${gatewayClass}`} title="Port 24" />
          </div>
          <div className={`mapNode workstationNode ${pcOnline ? 'online' : 'offline'}`}>
            <span className="nodeTypeBadge">WORKSTATION</span>
            <span>Workstation</span>
            <strong>Port 3 · 2.5 Gb</strong>
            <em>CPU {Math.round(clampPercent(metrics.pcCpu))}% / RAM {Math.round(clampPercent(metrics.pcRam))}%</em>
          </div>
          <div className={`mapNode serverNode ${serverOnline ? 'online' : 'offline'}`}>
            <span className="nodeTypeBadge">SERVER</span>
            <span>Proxmox Server</span>
            <strong>Port 1 · 2.5 Gb</strong>
            <em>CPU {Math.round(clampPercent(metrics.serverCpu))}% / RAM {Math.round(clampPercent(metrics.serverRam))}%</em>
          </div>
          <div className="mapNode meshNode">
            <span className="nodeTypeBadge">WIRELESS AP</span>
            <span>x25 Deco Mesh</span>
            <strong>Port 2 · 1 Gb</strong>
            <em>Wireless Clients</em>
          </div>

          <svg className="mapLines" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden="true">
            {/* ISP → Internet */}
            <path className={`staticLink ${gatewayClass}`} d="M500 93 L500 130" />
            <path className={`flowLink ${gatewayClass}`} d="M500 93 L500 130" />
            {/* Internet → Router */}
            <path className={`staticLink ${gatewayClass}`} d="M500 210 L500 248" />
            <path className={`flowLink ${gatewayClass}`} d="M500 210 L500 248" />
            {/* Router → Switch */}
            <path className={`staticLink ${gatewayClass}`} d="M500 330 L500 367" />
            <path className={`flowLink ${gatewayClass}`} d="M500 330 L500 367" />
            {/* Switch → Workstation */}
            <path className={`staticLink ${pcOnline ? pcClass : 'danger'}`} d="M393 477 L393 496 L205 496 L205 514" />
            <path className={`flowLink ${pcOnline ? pcClass : 'danger'}`} d="M393 477 L393 496 L205 496 L205 514" />
            {/* Switch → Mesh */}
            <path className={`staticLink ${meshClass}`} d="M500 477 L500 514" />
            <path className={`flowLink ${meshClass}`} d="M500 477 L500 514" />
            {/* Switch → Server */}
            <path className={`staticLink ${serverOnline ? serverClass : 'danger'}`} d="M607 477 L607 496 L795 496 L795 514" />
            <path className={`flowLink ${serverOnline ? serverClass : 'danger'}`} d="M607 477 L607 496 L795 496 L795 514" />
            {/* Workstation ↔ Server LAN segment — U-route below Deco Mesh */}
            <path className={`staticLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 551 L205 614 L795 614 L795 551" />
            <path className={`flowLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 551 L205 614 L795 614 L795 551" />
          </svg>
        </div>
      </Panel>
      <Panel title="PORT MAP" className="portPanel">
        <div className="portRows">
          {[
            ['24', 'Gateway Router', 'ACTIVE', formatPortRate(metrics.switchPort24Rx, metrics.switchPort24Tx)],
            ['1', 'Proxmox Server', serverOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx)],
            ['2', 'x25 Deco Mesh', 'ACTIVE', formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx)],
            ['3', 'Workstation', pcOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx)],
            ['4-22', 'Available', 'IDLE', '-']
          ].map(([port, device, state, rate]) => (
            <div className="portRow" key={port}>
              <strong>{port}</strong>
              <span>{device}</span>
              <em className={state === 'DOWN' ? 'down' : ''}>{state}</em>
              <b>{rate}</b>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function workerLabel(workerId) {
  const labels = {
    'local-qwen': 'LOCAL QWEN',
    'repo-bridge': 'REPO BRIDGE',
    'codex-review': 'CODEX REVIEW',
    'claude-cli': 'CLAUDE CLI',
    'rag-server': 'RAG SERVER'
  };
  return labels[workerId] || workerId?.toUpperCase?.() || 'UNROUTED';
}

const ATTACH_IGNORE = new Set(['node_modules', '.git', 'dist', '.venv', '__pycache__', '.cache', 'build', '.next', 'tmp']);
const ATTACH_EXTS = new Set(['.mjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.css', '.json', '.cjs', '.md', '.sh', '.ps1', '.yaml', '.yml']);
const MAX_FILE_BYTES = 8000;
const MAX_TOTAL_BYTES = 32000;

async function readFileText(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result || '');
    reader.onerror = () => resolve('[unreadable]');
    reader.readAsText(file);
  });
}

function ApplyStagedButton({ stageId }) {
  const [state, setState] = useState('idle');
  const [detail, setDetail] = useState('');

  async function apply() {
    setState('busy');
    try {
      const res = await fetch('/api/build/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: stageId }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `status ${res.status}`);
      setDetail(`Applied: ${data.applied.join(', ')}`);
      setState('done');
    } catch (err) {
      setDetail(err.message);
      setState('error');
    }
  }

  if (state === 'done') return <span className="applyStagedDone">✓ {detail}</span>;
  return (
    <span className="applyStagedWrap">
      <button type="button" className="applyStagedBtn" disabled={state === 'busy'} onClick={apply}>
        {state === 'busy' ? 'APPLYING…' : '⚡ APPLY CHANGES'}
      </button>
      {state === 'error' && <span className="applyStagedErr">✗ {detail}</span>}
    </span>
  );
}

function ChatSessionPanel({ history, busy, input, setInput, onSubmit, onCollapse, onStop, onClear, workflowMode, setWorkflowMode, attachedFiles, onAddFiles, onRemoveFile, permanent }) {
  const historyRef = useRef(null);
  const rafRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!history.length) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = historyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [history]);

  async function handleFilePick(e) {
    const files = Array.from(e.target.files || []);
    let total = 0;
    const items = [];
    for (const file of files.slice(0, 60)) {
      if (total >= MAX_TOTAL_BYTES) break;
      const raw = await readFileText(file);
      const content = raw.slice(0, MAX_FILE_BYTES);
      items.push({ name: file.name, content });
      total += content.length;
    }
    if (items.length) onAddFiles(items);
    e.target.value = '';
  }

  const [showFolderPicker, setShowFolderPicker] = useState(false);

  function handleFolderAdd() {
    setShowFolderPicker(true);
  }

  function handlePickerSelect(item) {
    if (!item?.path) return;
    const name = item.path.split(/[\\/]/).filter(Boolean).pop() || item.path;
    onAddFiles([{ name: name + (item.type === 'folder' ? '/' : ''), type: item.type, path: item.path }]);
  }

  return (
    <Panel title="MAVERICK // ORCHESTRATOR" className="chatSessionPanel">
      {!permanent && <button type="button" className="chatCollapseBtn" onClick={onCollapse}>↙ COLLAPSE</button>}
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={e => handleFilePick(e)} />
      <div className="chatSessionHistory" ref={historyRef}>
        {history.length === 0 && <div className="chatSessionEmpty">No messages yet. Send a command below.</div>}
        {history.map((msg, i) => {
          const stageMatch = msg.role === 'assistant' && (!busy || i < history.length - 1)
            ? msg.content?.match(/\[STAGED:(stage-[\w-]+)\]/)
            : null;
          return (
            <div key={i} className={`chatMsg ${msg.role}`}>
              <span className="chatRole">{msg.role === 'user' ? 'CMD' : 'MAV'}</span>
              <span className="chatText">{msg.content || (busy && i === history.length - 1 ? '▋' : '')}</span>
              {stageMatch && <ApplyStagedButton stageId={stageMatch[1]} />}
            </div>
          );
        })}
      </div>
      <div className="chatSessionModes">
        {WORKFLOW_MODES.map(mode => (
          <button
            key={mode.id}
            type="button"
            disabled={busy}
            onClick={() => setWorkflowMode(mode.id)}
            className={`workflowBtn${workflowMode === mode.id ? ` active ${mode.accent}` : ''}`}
            data-tooltip={mode.tooltip}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {attachedFiles?.length > 0 && (
        <div className="attachChips">
          {attachedFiles.map((f, i) => (
            <span key={i} className={`attachChip${f.type === 'folder' ? ' folderChip' : ''}`}>
              <span className="attachChipLabel" title={f.path || f.name}>{f.type === 'folder' ? '📁 ' : ''}{f.name.split(/[\\/]/).filter(Boolean).pop() || f.name}{f.type === 'folder' ? '/' : ''}</span>
              <button type="button" className="attachChipRemove" onClick={() => onRemoveFile(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      <form className="chatSessionForm" onSubmit={onSubmit}>
        <textarea
          className="chatSessionInput"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={busy ? 'Maverick is responding...' : 'Enter command or ask Maverick... (Shift+Enter for new line)'}
          disabled={busy}
          rows={3}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e); } }}
        />
        <div className="chatSessionActions">
          <button type="button" className="attachBtn" onClick={() => fileInputRef.current?.click()} title="Attach files">⊕ FILES</button>
          <button type="button" className="attachBtn" onClick={handleFolderAdd} title="Attach folder by path">⊕ FOLDER</button>
          {busy
            ? <button type="button" className="stopBtn" onClick={onStop}>[ STOP ]</button>
            : <button type="submit" className="sendBtn" disabled={!input.trim()}>SEND</button>
          }
          {history.length > 0 && !busy && (
            <button type="button" className="clearChatBtn" onClick={onClear}>CLR</button>
          )}
        </div>
      </form>
      {showFolderPicker && (
        <FolderPickerModal
          onSelect={handlePickerSelect}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </Panel>
  );
}

function OrchestratorPage({ modelStatus, chatSession }) {
  const orchestratorStatus = useOrchestratorStatus();
  const [idea, setIdea] = useState('Build an app with my standard tech stack that tells me where the closest ice cream shop is when it is 100 degrees outside.');
  const [activeRun, setActiveRun] = useState(null);
  const [workerBrief, setWorkerBrief] = useState(null);
  const [taskRuns, setTaskRuns] = useState([]);
  const [memoryContext, setMemoryContext] = useState({ state: 'loading', memories: [], results: [], typeCounts: {}, warnings: [] });
  const [busy, setBusy] = useState(false);
  const [briefBusyId, setBriefBusyId] = useState(null);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [error, setError] = useState(null);
  const run = activeRun || orchestratorStatus.runs?.[0] || null;

  useEffect(() => {
    setTaskRuns(orchestratorStatus.taskRuns || []);
  }, [orchestratorStatus.taskRuns]);

  useEffect(() => {
    let cancelled = false;
    async function loadMemory() {
      try {
        const next = await queryMemory(idea);
        if (!cancelled) setMemoryContext({ ...next, error: null });
      } catch (nextError) {
        if (!cancelled) setMemoryContext((current) => ({ ...current, state: 'error', error: nextError.message }));
      }
    }
    loadMemory();
    const timer = setTimeout(loadMemory, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [idea]);

  async function handlePlan(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWorkerBrief(null);
    try {
      const next = await createOrchestratorPlan(idea);
      setActiveRun(next);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleBrief(task) {
    setBriefBusyId(task.id);
    setError(null);
    try {
      const next = await createLocalWorkerBrief(run.idea, task);
      setWorkerBrief({ task, ...next });
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBriefBusyId(null);
    }
  }

  async function handleTaskRun(task) {
    setBriefBusyId(task.id);
    setError(null);
    try {
      const next = await createTaskRun(run.idea, task, 'brief');
      setTaskRuns((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      setWorkerBrief({ task, brief: next.output || next.error || 'Task run completed without output.', createdAt: next.finishedAt, ledgerRun: next });
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBriefBusyId(null);
    }
  }

  async function handleRunStatus(id, patch) {
    setReviewBusyId(id);
    setError(null);
    try {
      const next = await updateTaskRun(id, patch);
      setTaskRuns((current) => current.map((item) => item.id === id ? next : item));
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setReviewBusyId(null);
    }
  }

  return (
    <div className="orchestratorPage">
      <ChatSessionPanel
        permanent
        history={chatSession.history}
        busy={chatSession.busy}
        input={chatSession.input}
        setInput={chatSession.setInput}
        onSubmit={chatSession.onSubmit}
        onCollapse={chatSession.onCollapse}
        onStop={chatSession.onStop}
        onClear={chatSession.onClear}
        workflowMode={chatSession.workflowMode}
        setWorkflowMode={chatSession.setWorkflowMode}
        attachedFiles={chatSession.attachedFiles}
        onAddFiles={chatSession.onAddFiles}
        onRemoveFile={chatSession.onRemoveFile}
      />

      <Panel title="MEMORY CONTEXT" className="memoryPanel">
        <div className="memorySummary">
          <strong>{memoryContext.count ?? memoryContext.memories?.length ?? 0} MEMORIES</strong>
          <span>{memoryContext.source === 'repo-bridge' ? 'WINDOWS BRIDGE' : (memoryContext.state || 'UNKNOWN').toUpperCase()}</span>
        </div>
        <div className="memoryTypes">
          {Object.entries(memoryContext.typeCounts || {}).map(([type, count]) => (
            <span key={type}>{type}: {count}</span>
          ))}
        </div>
        <div className="memoryMatches">
          {(memoryContext.results || memoryContext.memories || []).slice(0, 4).map((memory) => (
            <div className="memoryMatch" key={memory.id}>
              <strong>{memory.id}</strong>
              <span>{memory.type}</span>
              <p>{memory.description}</p>
            </div>
          ))}
        </div>
        {memoryContext.warnings?.length ? <em className="memoryWarning">{memoryContext.warnings[0]}</em> : null}
        {memoryContext.error ? <em className="memoryWarning">{memoryContext.error}</em> : null}
      </Panel>

      <Panel title="IMPLEMENTATION PLAN" className="planPanel">
        {run ? (
          <>
            <div className="planSummary">{run.plan.summary}</div>
            <div className="taskList">
              {run.plan.tasks.map((task) => (
                <div className="taskRow" key={task.id}>
                  <strong>{task.title}</strong>
                  <span>{workerLabel(task.worker)}</span>
                  <em>{task.reason}</em>
                  <button
                    type="button"
                    disabled={task.worker !== 'local-qwen' || briefBusyId === task.id}
                    onClick={() => handleBrief(task)}
                  >
                    Brief
                  </button>
                  <button
                    type="button"
                    disabled={task.worker !== 'local-qwen' || briefBusyId === task.id}
                    onClick={() => handleTaskRun(task)}
                  >
                    {briefBusyId === task.id ? 'Running...' : 'Run + Log'}
                  </button>
                </div>
              ))}
            </div>
            <div className="verifyRail">
              {run.plan.verification.map((step) => <span key={step}>{step}</span>)}
            </div>
          </>
        ) : (
          <div className="emptyPlan">No run yet. Create a plan to route work across local and hosted workers.</div>
        )}
      </Panel>

      <Panel title="TASK LEDGER" className="ledgerPanel">
        {taskRuns.length ? (
          <div className="ledgerList">
            {taskRuns.slice(0, 8).map((taskRun) => (
              <div className="ledgerRow" key={taskRun.id}>
                <div>
                  <strong>{taskRun.taskTitle}</strong>
                  <span>{workerLabel(taskRun.worker)} / {taskRun.status}</span>
                  <em>{taskRun.changedFiles?.length ? taskRun.changedFiles.join(', ') : 'No changed files captured yet'}</em>
                  {taskRun.diffStat ? <code>{taskRun.diffStat}</code> : null}
                </div>
                <div className="ledgerBadges">
                  <span>{taskRun.reviewStatus}</span>
                  <span>{taskRun.deployStatus}</span>
                </div>
                <div className="ledgerActions">
                  <button
                    type="button"
                    disabled={reviewBusyId === taskRun.id || taskRun.reviewStatus === 'approved'}
                    onClick={() => handleRunStatus(taskRun.id, { reviewStatus: 'approved', status: 'approved', deployStatus: 'ready' })}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={reviewBusyId === taskRun.id || taskRun.deployStatus === 'deployed'}
                    onClick={() => handleRunStatus(taskRun.id, { deployStatus: 'deployed', status: 'deployed' })}
                  >
                    Deployed
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="emptyPlan">No task runs logged yet. Use Run + Log to create the first audit record.</div>
        )}
      </Panel>

      <Panel title="LOCAL WORKER BRIEF" className="briefPanel">
        {workerBrief ? (
          <>
            <div className="briefTask">{workerBrief.task.title}</div>
            <pre>{workerBrief.brief}</pre>
          </>
        ) : (
          <div className="emptyPlan">Select a local Qwen task brief after planning.</div>
        )}
      </Panel>

      {(error || orchestratorStatus.error) ? <div className="errorStrip">{error || orchestratorStatus.error}</div> : null}
    </div>
  );
}

function FolderPickerModal({ onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState('C:\\');
  const [inputVal, setInputVal] = useState('C:\\');
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  async function loadPath(p) {
    setLoading(true);
    try {
      const res = await fetch(`/api/list-dirs?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      setCurrentPath(data.path);
      setInputVal(data.path);
      setDirs(data.dirs || []);
      setFiles(data.files || []);
    } catch {}
    setLoading(false);
  }

  useEffect(() => { loadPath('C:\\'); }, []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleInputKey(e) {
    if (e.key === 'Enter') loadPath(inputVal);
  }

  function navigate(sub) {
    const next = currentPath.replace(/[\\/]$/, '') + '\\' + sub;
    loadPath(next);
  }

  function selectFile(name) {
    const fullPath = currentPath.replace(/[\\/]$/, '') + '\\' + name;
    onSelect({ path: fullPath, type: 'file' });
    onClose();
  }

  function winJoin(parts) {
    const joined = parts.join('\\');
    // Bare drive letter like 'C:' must become 'C:\' so path.resolve gets the root
    return /^[A-Za-z]:$/.test(joined) ? joined + '\\' : joined || 'C:\\';
  }

  function goUp() {
    const parts = currentPath.replace(/[\\/]$/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return;
    parts.pop();
    loadPath(winJoin(parts));
  }

  const crumbs = currentPath.replace(/[\\/]$/, '').split(/[\\/]/).filter(Boolean);

  return (
    <div className="folderPickerOverlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="folderPickerModal">
        <div className="folderPickerHeader">
          <span className="folderPickerTitle">Select Folder</span>
          <button className="folderPickerClose" onClick={onClose}>✕</button>
        </div>

        <div className="folderPickerCrumbs">
          {crumbs.map((seg, i) => (
            <React.Fragment key={i}>
              <button
                className="folderPickerCrumb"
                onClick={() => loadPath(winJoin(crumbs.slice(0, i + 1)))}
              >{seg}</button>
              {i < crumbs.length - 1 && <span className="folderPickerSep">›</span>}
            </React.Fragment>
          ))}
        </div>

        <div className="folderPickerPathRow">
          <input
            ref={inputRef}
            className="folderPickerInput"
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={handleInputKey}
            placeholder="Type a path and press Enter"
            spellCheck={false}
          />
          <button className="folderPickerGoBtn" onClick={() => loadPath(inputVal)}>Go</button>
        </div>

        <div className="folderPickerList">
          {crumbs.length > 1 && (
            <button className="folderPickerEntry folderPickerUp" onClick={goUp}>↑ ..</button>
          )}
          {loading && <div className="folderPickerLoading">Loading…</div>}
          {!loading && dirs.length === 0 && files.length === 0 && <div className="folderPickerEmpty">Empty directory</div>}
          {!loading && dirs.map(name => (
            <button key={`d:${name}`} className="folderPickerEntry folderPickerDir" onDoubleClick={() => navigate(name)} onClick={() => setInputVal(currentPath.replace(/[\\/]$/, '') + '\\' + name)}>
              <span className="folderPickerIcon">📁</span> {name}
            </button>
          ))}
          {!loading && files.map(name => (
            <button key={`f:${name}`} className="folderPickerEntry folderPickerFile" onClick={() => selectFile(name)}>
              <span className="folderPickerIcon">📄</span> {name}
            </button>
          ))}
        </div>

        <div className="folderPickerFooter">
          <span className="folderPickerSelected">{inputVal}</span>
          <div className="folderPickerActions">
            <button className="folderPickerCancel" onClick={onClose}>Cancel</button>
            <button className="folderPickerConfirm" onClick={() => { onSelect({ path: inputVal, type: 'folder' }); onClose(); }}>Add Path</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BuildChatPanel() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stagedId, setStagedId] = useState(null);
  const [stagedFiles, setStagedFiles] = useState([]);
  const [applyStatus, setApplyStatus] = useState('');
  const [attachedFolders, setAttachedFolders] = useState([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const abortRef = useRef(null);
  const historyRef = useRef([]);
  const bottomRef = useRef(null);

  function handleItemSelected(item) {
    if (!item?.path) return;
    setAttachedFolders(prev => prev.find(f => f.path === item.path) ? prev : [...prev, item]);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setStagedId(null);
    setStagedFiles([]);
    setApplyStatus('');
    setAttachedFolders([]);

    const userMsg = { role: 'user', content: text };
    const pendingMsg = { role: 'assistant', content: '', statuses: [], qc: '', actions: [] };
    setMessages(prev => [...prev, userMsg, pendingMsg]);
    historyRef.current = [...historyRef.current, { role: 'user', content: text }].slice(-20);

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let accum = '';
    let qcAccum = '';

    try {
      const res = await fetch('/api/build-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, history: historyRef.current.slice(0, -1), attachments: attachedFolders }),
        signal: controller.signal
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break;
          try {
            const evt = JSON.parse(raw);
            setMessages(prev => {
              const next = [...prev];
              const last = { ...next[next.length - 1] };
              if (evt.type === 'status' || evt.type === 'warning') {
                last.statuses = [...(last.statuses || []), evt.text];
              } else if (evt.type === 'token') {
                accum += evt.text;
                last.content = accum;
              } else if (evt.type === 'qc') {
                qcAccum = evt.text;
                last.qc = qcAccum;
              } else if (evt.type === 'action') {
                last.actions = [...(last.actions || []), evt];
              } else if (evt.type === 'staged') {
                setStagedId(evt.id);
                setStagedFiles(evt.files || []);
              }
              next[next.length - 1] = last;
              return next;
            });
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], content: `[Error: ${err.message}]` };
          return next;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      if (accum) {
        historyRef.current = [...historyRef.current, { role: 'assistant', content: accum }].slice(-20);
      }
    }
  }

  async function handleApply() {
    if (!stagedId) return;
    setApplyStatus('Applying...');
    try {
      const r = await fetch('/api/build/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagedId })
      });
      const data = await r.json();
      if (r.ok) {
        setApplyStatus(`Applied ${data.applied || stagedFiles.length} file(s).`);
        setStagedId(null);
      } else {
        setApplyStatus(`Apply failed: ${data.error || r.status}`);
      }
    } catch (err) {
      setApplyStatus(`Apply error: ${err.message}`);
    }
  }

  return (
    <div className="buildChatPage">
      <div className="panel buildChatPanel">
        <div className="panelTitle">BUILD CHAT — CLAUDE ARCHITECT → QWEN EXECUTOR → NIM QC</div>

        <div className="buildChatHistory" ref={bottomRef}>
          {messages.length === 0 && (
            <div className="buildChatEmpty">Describe a code change — Claude plans, Qwen executes, NIM reviews.</div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`buildChatMsg ${msg.role}`}>
              {msg.role === 'user' ? (
                <>
                  <span className="buildChatRole">CMD</span>
                  <span className="buildChatText">{msg.content}</span>
                </>
              ) : (
                <>
                  <span className="buildChatRole">BUILD</span>
                  <div className="buildChatBody">
                    {(msg.statuses || []).map((s, si) => (
                      <div key={si} className="buildChatStatus">{s}</div>
                    ))}
                    {(msg.actions || []).map((a, ai) => (
                      <div key={ai} className={`buildChatAction ${a.ok ? 'ok' : 'err'}`}>
                        {a.ok ? '✓' : '✗'} {a.tool}({a.path})
                      </div>
                    ))}
                    {msg.content && <div className="buildChatContent"><MavMarkdown content={msg.content} /></div>}
                    {msg.qc && (
                      <div className="buildChatQc">
                        <span className="buildChatQcLabel">NIM QC</span>
                        <pre className="buildChatQcText">{msg.qc}</pre>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {stagedId && (
          <div className="buildChatStaged">
            <span className="buildChatStagedLabel">STAGED: {stagedFiles.join(', ')}</span>
            <button className="buildChatApplyBtn" onClick={handleApply} disabled={!!applyStatus}>
              {applyStatus || 'APPLY TO WORKSPACE'}
            </button>
          </div>
        )}
        {!stagedId && applyStatus && (
          <div className="buildChatAppliedNote">{applyStatus}</div>
        )}

        {attachedFolders.length > 0 && (
          <div className="buildChatFolders">
            {attachedFolders.map(f => (
              <span key={f.path} className="buildChatFolderChip">
                {f.type === 'file' ? '📄' : '📁'} {f.path.split(/[\\/]/).filter(Boolean).pop()}
                <button type="button" className="buildChatFolderRemove" onClick={() => setAttachedFolders(prev => prev.filter(x => x.path !== f.path))}>×</button>
              </span>
            ))}
          </div>
        )}
        <form className="buildChatInputRow" onSubmit={handleSubmit}>
          <button type="button" className="buildChatFolderBtn" onClick={() => setShowFolderPicker(true)} disabled={busy} title="Attach a folder for Claude to focus on">📁</button>
          <input
            className="chatInput"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Describe a code change..."
            disabled={busy}
            autoFocus
          />
          {busy
            ? <button type="button" className="buildChatStopBtn" onClick={() => abortRef.current?.abort()}>STOP</button>
            : <button type="submit" className="buildChatSendBtn" disabled={!input.trim()}>SEND</button>
          }
        </form>
      </div>
      {showFolderPicker && (
        <FolderPickerModal
          onSelect={handleItemSelected}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </div>
  );
}

function HomePage({ modelStatus }) {
  const orchestratorStatus = useOrchestratorStatus();
  const seoWorkflow = useSeoWorkflow();
  const [actionQueue, setActionQueue] = useState(null);
  const [actionBusyId, setActionBusyId] = useState('');
  const [actionResult, setActionResult] = useState(null);
  const [listModal, setListModal] = useState(null);
  const taskRuns = orchestratorStatus.taskRuns || [];
  const workers = orchestratorStatus.workers || [];
  const onlineWorkers = workers.filter((worker) => /online|available|manual/i.test(worker.state || '')).length;
  const statusCounts = seoWorkflow.statusCounts || {};
  const reports = seoWorkflow.reports || [];
  const actions = actionQueue?.actions || seoWorkflow.workflowStatus?.actions?.actions || seoWorkflow.actions?.actions || [];
  const actionSummary = actionQueue?.summary || seoWorkflow.workflowStatus?.actions?.summary || seoWorkflow.actions?.summary || {};
  const nowMs = Date.now();
  const sevenDaysAgoMs = nowMs - (7 * 24 * 60 * 60 * 1000);
  const reportsLast7Days = reports.filter((report) => {
    const reportTime = new Date(report.updatedAt).getTime();
    return Number.isFinite(reportTime) && reportTime >= sevenDaysAgoMs;
  });
  const upcomingActions = actions
    .filter((action) => {
      const status = String(action.status || '').toLowerCase();
      const done = String(action.completion?.completion_status || '').toLowerCase() === 'complete'
        || String(action.completion?.definition_of_done || '').toLowerCase() === 'yes';
      return !done && !['dry_run_ready', 'complete', 'completed', 'verified'].includes(status);
    })
    .sort((a, b) => {
      const rank = { needs_approval: 0, approved: 1, blocked_access: 2, needs_review: 3 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    });
  const runHealth = seoWorkflow.runHealth || null;
  const failedPhases = runHealth
    ? Object.entries(runHealth).filter(([, v]) => v?.status === 'failed')
    : [];
  const faults = [
    ...(seoWorkflow.faults || []),
    ...(actionQueue?.error ? [actionQueue.error] : []),
    ...(orchestratorStatus.error ? [orchestratorStatus.error] : [])
  ];
  const recentReports = reports
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const visibleActions = upcomingActions.slice(0, 5);
  const visibleReports = recentReports.slice(0, 5);
  const visibleTaskRuns = taskRuns.slice(0, 5);
  const activeWorkflow = seoWorkflow.activeWorkflow || {
    name: 'SEO Automation',
    phase: seoWorkflow.state || 'loading',
    reportsGenerated: reportsLast7Days.length
  };
  function runHealthLabel(phase) {
    return { research: 'RESEARCH', execute: 'EXECUTE', post_schedule: 'GBP SCHED' }[phase] || phase.toUpperCase();
  }
  function runAgeLabel(iso) {
    if (!iso) return '';
    const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
    if (h < 1) return '< 1h ago';
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  async function refreshActions() {
    try {
      setActionQueue(await querySeoActions());
    } catch (error) {
      setActionQueue((current) => ({ ...(current || {}), error: error.message }));
    }
  }

  function renderActionRow(action) {
    const isBusy = actionBusyId === action.id;
    const isApproved = action.status === 'approved' || Boolean(action.approval);
    const canApprove = action.status === 'needs_approval' && action.approval_required && !action.approval;
    const canRunLive = Boolean(action.live_adapter) && isApproved;
    const canApproveAndRun = Boolean(action.live_adapter) && canApprove;

    return (
      <div className="actionRow actionQueueRow" key={action.id}>
        <div>
          <strong>{action.title}</strong>
          <span>{action.status} / {action.platform} / {action.risk}</span>
          <em>{action.assigned_agent}</em>
        </div>
        <div className="actionButtons">
          <button type="button" disabled={isBusy} onClick={() => handleDryRunAction(action.id)}>
            Dry Run
          </button>
          <button
            type="button"
            disabled={isBusy || !canApprove}
            onClick={() => handleApproveAction(action.id)}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={isBusy || !canApproveAndRun}
            onClick={() => handleApproveAndRunAction(action.id)}
          >
            Approve + Run
          </button>
          <button
            type="button"
            disabled={isBusy || !canRunLive}
            onClick={() => handleLiveRunAction(action.id)}
          >
            Run Live
          </button>
        </div>
      </div>
    );
  }

  function renderReportRow(report) {
    return (
      <div className="reportRow" key={report.name}>
        <strong>{(report.name || '').replace(/_/g, ' ')}</strong>
        <span>{new Date(report.updatedAt).toLocaleString()}</span>
        <em>{report.displayTitle || report.headings?.[0] || report.summary?.[0] || 'Report ready'}</em>
      </div>
    );
  }

  function renderTaskRunRow(taskRun) {
    return (
      <div className="recentTaskRow" key={taskRun.id}>
        <strong>{taskRun.taskTitle}</strong>
        <span>{workerLabel(taskRun.worker)} / {taskRun.status}</span>
      </div>
    );
  }

  const modalConfig = listModal === 'actions'
    ? { title: 'Upcoming Actions', count: upcomingActions.length, rows: upcomingActions.map(renderActionRow), empty: 'No upcoming actions detected.' }
    : listModal === 'reports'
      ? { title: 'Recent Reports', count: recentReports.length, rows: recentReports.map(renderReportRow), empty: 'No reports detected.' }
      : listModal === 'tasks'
        ? { title: 'Recent Task Runs', count: taskRuns.length, rows: taskRuns.map(renderTaskRunRow), empty: 'No task runs logged yet.' }
        : null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await querySeoActions();
        if (!cancelled) setActionQueue(next);
      } catch (error) {
        if (!cancelled) setActionQueue((current) => ({ ...(current || {}), error: error.message }));
      }
    }
    load();
    const timer = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function handleApproveAction(actionId) {
    setActionBusyId(actionId);
    try {
      const result = await approveSeoAction(actionId, 'Approved from MCC action queue.');
      setActionResult({ kind: 'approve', actionId, result });
      await refreshActions();
    } catch (error) {
      setActionResult({ kind: 'error', actionId, error: error.message });
    } finally {
      setActionBusyId('');
    }
  }

  async function handleDryRunAction(actionId) {
    setActionBusyId(actionId);
    try {
      const result = await runSeoAction(actionId, false);
      setActionResult({ kind: 'dry-run', actionId, result });
      await refreshActions();
    } catch (error) {
      setActionResult({ kind: 'error', actionId, error: error.message });
    } finally {
      setActionBusyId('');
    }
  }

  async function handleLiveRunAction(actionId) {
    setActionBusyId(actionId);
    try {
      const result = await runSeoAction(actionId, true);
      setActionResult({ kind: 'live-run', actionId, result });
      await refreshActions();
    } catch (error) {
      setActionResult({ kind: 'error', actionId, error: error.message });
    } finally {
      setActionBusyId('');
    }
  }

  async function handleApproveAndRunAction(actionId) {
    setActionBusyId(actionId);
    try {
      const approval = await approveSeoAction(actionId, 'Approved and queued for live run from MCC action queue.');
      const run = await runSeoAction(actionId, true);
      setActionResult({ kind: 'approve-run', actionId, result: { approval, run } });
      await refreshActions();
    } catch (error) {
      setActionResult({ kind: 'error', actionId, error: error.message });
    } finally {
      setActionBusyId('');
    }
  }

  return (
    <div className="homePage">
      <Panel title="OPERATIONS COMMAND" className="homeHero">
        <div className="homeHeroGrid">
          <div>
            <span>PRIMARY WORKFLOW</span>
            <strong>{activeWorkflow.name}</strong>
            <em>{activeWorkflow.phase}</em>
          </div>
          <div>
            <span>AGENT FLEET</span>
            <strong>{onlineWorkers} / {workers.length}</strong>
            <em>{modelStatus.state === 'online' ? 'LOCAL AI READY' : 'LOCAL AI OFFLINE'}</em>
          </div>
          <div>
            <span>7-DAY REPORTS</span>
            <strong>{reportsLast7Days.length}</strong>
            <em>{seoWorkflow.source === 'repo-bridge' ? 'WINDOWS BRIDGE' : (seoWorkflow.state || 'UNKNOWN').toUpperCase()}</em>
          </div>
          <div>
            <span>FAULTS</span>
            <strong>{faults.length}</strong>
            <em>{faults.length ? 'NEEDS REVIEW' : 'CLEAR'}</em>
          </div>
          <div>
            <span>LOCAL MODEL</span>
            <strong style={{ fontSize: modelStatus.model ? '16px' : '30px' }}>
              {modelStatus.model ? modelStatus.model.replace(/^[^/]+\//, '') : (modelStatus.state === 'loading' ? '...' : 'OFFLINE')}
            </strong>
            <em>{modelStatus.contextTokens != null ? `${modelStatus.contextTokens.toLocaleString()} CTX` : modelStatus.state.toUpperCase()}</em>
          </div>
        </div>
      </Panel>

      <Panel title="ACTIVE WORKFLOWS" className="workflowPanel">
        <div className="workflowCard">
          <strong>{activeWorkflow.name}</strong>
          <span>{activeWorkflow.phase}</span>
          <em>{reportsLast7Days.length} reports in last 7 days</em>
        </div>
        <div className="workflowStats">
          <span>Complete: {statusCounts.complete || 0}</span>
          <span>Partial: {statusCounts.partial || 0}</span>
          <span>Blocked: {statusCounts.blocked || 0}</span>
          <span>Incomplete: {statusCounts.incomplete || 0}</span>
          <span>Needs approval: {actionSummary.needs_approval || 0}</span>
          <span>Access blocked: {actionSummary.blocked_access || 0}</span>
        </div>
        <div className={`workflowFaultStrip ${faults.length ? 'hasFaults' : ''}`}>
          <span>{faults.length ? 'Faults / Blockers' : 'Faults'}</span>
          <strong>{faults.length ? faults.length : 'Clear'}</strong>
          <em>{faults[0] || 'No current workflow faults.'}</em>
        </div>
        {runHealth && (
          <div className="runHealthStrip">
            <span className="runHealthLabel">LAST RUNS</span>
            <div className="runHealthPhases">
              {Object.entries(runHealth).map(([phase, entry]) => (
                <div key={phase} className={`runHealthPhase ${entry?.status === 'failed' ? 'failed' : 'ok'}`}>
                  <span>{runHealthLabel(phase)}</span>
                  <strong>{entry?.status === 'failed' ? '✗ FAILED' : '✓ OK'}</strong>
                  <em>{runAgeLabel(entry?.at)}</em>
                </div>
              ))}
            </div>
            {failedPhases.length > 0 && (
              <div className="runHealthAlert">
                ⚠ {failedPhases.length} phase{failedPhases.length > 1 ? 's' : ''} failed — check logs before next Friday run
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="AGENT FLEET" className="agentFleetPanel">
        <div className="agentFleetList">
          {workers.map((worker) => (
            <div className="agentFleetRow" key={worker.id}>
              <span className={/online|available|manual/i.test(worker.state || '') ? 'ok' : 'warn'} />
              <strong>{workerLabel(worker.id)}</strong>
              <em>{worker.state}</em>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="UPCOMING ACTIONS" className="actionsPanel">
        <div className="panelListToolbar">
          <span>{upcomingActions.length} total</span>
          <button type="button" disabled={upcomingActions.length <= 5} onClick={() => setListModal('actions')}>View all</button>
        </div>
        <div className="actionList compactList">
          {visibleActions.map(renderActionRow)}
          {!upcomingActions.length ? <div className="emptyPlan">No upcoming actions detected.</div> : null}
          {actionResult ? (
            <div className={actionResult.kind === 'error' ? 'actionResult error' : 'actionResult'}>
              {actionResult.kind === 'error'
                ? actionResult.error
                : `${actionResult.kind}: ${actionResult.result.status || actionResult.result.state || 'complete'}`}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="RECENT REPORTS" className="reportsPanel">
        <div className="panelListToolbar">
          <span>{recentReports.length} total</span>
          <button type="button" disabled={recentReports.length <= 5} onClick={() => setListModal('reports')}>View all</button>
        </div>
        <div className="reportList compactList">
          {visibleReports.map(renderReportRow)}
        </div>
      </Panel>

      <Panel title="RECENT TASK RUNS" className="recentTaskPanel">
        <div className="panelListToolbar">
          <span>{taskRuns.length} total</span>
          <button type="button" disabled={taskRuns.length <= 5} onClick={() => setListModal('tasks')}>View all</button>
        </div>
        <div className="recentTaskList compactList">
          {visibleTaskRuns.map(renderTaskRunRow)}
          {!taskRuns.length ? <div className="emptyPlan">No task runs logged yet.</div> : null}
        </div>
      </Panel>

      {modalConfig ? (
        <div className="listModalOverlay" role="presentation" onClick={() => setListModal(null)}>
          <section className="listModal" role="dialog" aria-modal="true" aria-label={modalConfig.title} onClick={(event) => event.stopPropagation()}>
            <div className="listModalHead">
              <div>
                <span>{modalConfig.count} total</span>
                <strong>{modalConfig.title}</strong>
              </div>
              <button type="button" onClick={() => setListModal(null)}>Close</button>
            </div>
            <div className="listModalBody">
              {modalConfig.rows.length ? modalConfig.rows : <div className="emptyPlan">{modalConfig.empty}</div>}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

const WORKFLOW_MODES = [
  { id: 'ask',   label: 'ASK MAVERICK',  accent: 'cyan',  tooltip: 'Ask questions, request research, or check system status' },
  { id: 'build', label: 'BUILD / FIX',   accent: 'amber', tooltip: 'Generate code, fix bugs, or build features with file context' },
  { id: 'ops',   label: 'OPERATIONS',    accent: 'green', tooltip: 'Trigger pipelines, run agents, manage automation workflows' },
];

const MAV_RAG_URL = 'http://192.168.1.12:8181/estimate';

function App() {

  const modelStatus = useModelStatus();
  const orchestratorStatus = useOrchestratorStatus();
  const { metrics, status } = useMetrics();

  const [view, setView] = useState('home');
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);
  const [workflowMode, setWorkflowMode] = useState('ask');
  const [chatHistory, setChatHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mcc-chat-history') || '[]'); } catch { return []; }
  });
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const chatAbortRef = useRef(null);
  const maverickHistoryRef = useRef([]);
  const [previewContent, setPreviewContent] = useState(null);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const barFileInputRef = useRef(null);


  const activeMode = WORKFLOW_MODES.find(m => m.id === workflowMode) || WORKFLOW_MODES[0];

  function pushChat(messages) {
    setChatHistory(prev => {
      const next = typeof messages === 'function' ? messages(prev) : messages;
      try { localStorage.setItem('mcc-chat-history', JSON.stringify(next.slice(-40))); } catch {}
      return next;
    });
  }

  async function handleChatSubmit(e) {
    e.preventDefault();
    if (!chatInput.trim() || chatBusy) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatBusy(true);
    setChatPanelOpen(true);
    pushChat(prev => [...prev, { role: 'user', content: userMsg }, { role: 'assistant', content: '' }]);

    const controller = new AbortController();
    chatAbortRef.current = controller;

    if (workflowMode === 'ask') {
      try {
        const history = maverickHistoryRef.current;
        const res = await fetch(MAV_RAG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: userMsg, history, top_k: 12 }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`RAG API ${res.status}`);
        const data = await res.json();
        const reply = data.reply || '[No response]';
        maverickHistoryRef.current = [...history, { role: 'user', content: userMsg }, { role: 'assistant', content: reply }];
        pushChat(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: reply };
          return next;
        });
        if (isDocumentResponse(reply)) setPreviewContent(reply);
      } catch (err) {
        if (err.name !== 'AbortError') {
          pushChat(prev => {
            const next = [...prev];
            next[next.length - 1] = { role: 'assistant', content: `[Error: ${err.message}]` };
            return next;
          });
        }
      } finally {
        setChatBusy(false);
        chatAbortRef.current = null;
      }
      return;
    }

    let accum = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: userMsg, mode: workflowMode, history: chatHistory, attachments: attachedFiles }),
        signal: controller.signal
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const tok = JSON.parse(raw);
            const delta = tok.choices?.[0]?.delta?.content || '';
            if (delta) {
              accum += delta;
              pushChat(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: accum };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        pushChat(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: `[Error: ${err.message}]` };
          return next;
        });
      }
    } finally {
      setChatBusy(false);
      chatAbortRef.current = null;
    }
  }

  return (
    <DashboardViewContext.Provider value={[view, setView]}>
      <div className="appShell">
      <Sidebar status={status} modelStatus={modelStatus} />
      <main className="dashboard">
        <div className="pageWrapper" key={view}>
        {view === 'home' ? (
          <HomePage modelStatus={modelStatus} />
        ) : view === 'hardware' ? (
          <div className="mainGrid hardwareGrid">
            <Workstation metrics={metrics} />
            <ModelOps metrics={metrics} modelStatus={modelStatus} orchestratorStatus={orchestratorStatus} />
            <Network metrics={metrics} />
            <Server metrics={metrics} />
            <Storage metrics={metrics} />
            <Services metrics={metrics} />
          </div>
        ) : view === 'network' ? (
          <NetworkMapPage metrics={metrics} />
        ) : view === 'seo' ? (
          <SEOApprovalPage />
        ) : (
          <OrchestratorPage
            modelStatus={modelStatus}
            chatSession={{
              expanded: chatExpanded,
              history: chatHistory,
              busy: chatBusy,
              input: chatInput,
              setInput: setChatInput,
              onSubmit: handleChatSubmit,
              onCollapse: () => setChatExpanded(false),
              onStop: () => chatAbortRef.current?.abort(),
              onClear: () => { pushChat([]); maverickHistoryRef.current = []; setPreviewContent(null); setAttachedFiles([]); },
              workflowMode,
              setWorkflowMode,
              attachedFiles,
              onAddFiles: (items) => setAttachedFiles(prev => [...prev, ...items]),
              onRemoveFile: (i) => setAttachedFiles(prev => prev.filter((_, idx) => idx !== i)),
            }}
          />
        )}
        {status.error ? <div className="errorStrip">{status.error}</div> : null}

        {previewContent && (
          <div className="docPreview">
            <div className="docPreviewHeader">
              <span className="docPreviewLabel">DOCUMENT PREVIEW</span>
              <button className="docPreviewClose" onClick={() => setPreviewContent(null)}>✕ Close</button>
            </div>
            <div className="docPreviewBody">
              <MavMarkdown content={previewContent} />
            </div>
          </div>
        )}
        </div>{/* /pageWrapper */}

        {view !== 'orchestrator' && <div className="commandBar" style={{marginLeft: 0}}>
          {chatPanelOpen && chatHistory.length > 0 && (
            <div className="chatHistory">
              {chatHistory.slice(-6).map((msg, i) => {
                const content = msg.content || (chatBusy && i === chatHistory.length - 1 ? '...' : '');
                const isDoc = msg.role === 'assistant' && isDocumentResponse(msg.content);
                return (
                  <div key={i} className={`chatMsg ${msg.role}`}>
                    <span className="chatRole">{msg.role === 'user' ? 'CMD' : 'MAV'}</span>
                    <span className="chatText">
                      {isDoc ? msg.content.slice(0, 120) + '…' : content}
                    </span>
                    {isDoc && (
                      <button className="chatPreviewBtn" onClick={() => setPreviewContent(msg.content)}>
                        ↑ Preview
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="workflowStrip">
            {WORKFLOW_MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                disabled={chatBusy}
                onClick={() => setWorkflowMode(mode.id)}
                className={`workflowBtn${workflowMode === mode.id ? ` active ${mode.accent}` : ''}`}
                data-tooltip={mode.tooltip}
              >
                {mode.label}
              </button>
            ))}
            <span className="modelRouteBadge">
              {activeMode.model === 'RAG' ? '◈ MAV RAG' : activeMode.model === 'GEMINI' ? '⬡ GEMINI FLASH' : '◈ LOCAL QWEN'}
            </span>
            <button
              type="button"
              className="expandChatBtn"
              onClick={() => { setChatExpanded(true); setView('orchestrator'); }}
              title="Open full chat window in Orchestrator tab"
            >
              ↗ EXPAND
            </button>
          </div>
          {attachedFiles.length > 0 && (
            <div className="attachChips barChips">
              {attachedFiles.map((f, i) => (
                <span key={i} className={`attachChip${f.type === 'folder' ? ' folderChip' : ''}`}>
                  <span className="attachChipLabel" title={f.path || f.name}>{f.type === 'folder' ? '📁 ' : ''}{f.name.split(/[\\/]/).filter(Boolean).pop() || f.name}{f.type === 'folder' ? '/' : ''}</span>
                  <button type="button" className="attachChipRemove" onClick={() => setAttachedFiles(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
          <form className="chatForm" onSubmit={handleChatSubmit}>
            <input ref={barFileInputRef} type="file" multiple style={{ display: 'none' }} onChange={async e => {
              const files = Array.from(e.target.files || []);
              let total = 0;
              const items = [];
              for (const file of files.slice(0, 20)) {
                if (total >= MAX_TOTAL_BYTES) break;
                const raw = await readFileText(file);
                const content = raw.slice(0, MAX_FILE_BYTES);
                items.push({ name: file.name, content });
                total += content.length;
              }
              if (items.length) setAttachedFiles(prev => [...prev, ...items]);
              e.target.value = '';
            }} />
            <span className="chatPrompt">CMD &gt;</span>
            <input
              type="text"
              className="chatInput"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              placeholder={chatBusy ? 'Maverick is responding...' : 'Enter command or ask Maverick...'}
              disabled={chatBusy}
            />
            <button type="button" className="attachBtn compact" title="Attach files as context" onClick={() => barFileInputRef.current?.click()}>⊕</button>
            {chatBusy ? (
              <button type="button" className="stopBtn" onClick={() => chatAbortRef.current?.abort()}>[ STOP ]</button>
            ) : (
              <button type="submit" className="sendBtn" disabled={!chatInput.trim()}>SEND</button>
            )}
            {chatHistory.length > 0 && (
              <button type="button" className="chatToggleBtn" onClick={() => setChatPanelOpen(p => !p)}>
                {chatPanelOpen ? '▼' : '▲'}
              </button>
            )}
            {chatHistory.length > 0 && !chatBusy && (
              <button type="button" className="clearChatBtn" onClick={() => { pushChat([]); maverickHistoryRef.current = []; setPreviewContent(null); setAttachedFiles([]); }}>CLR</button>
            )}
          </form>
        </div>}
      </main>
      </div>{/* /appShell */}
    </DashboardViewContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
