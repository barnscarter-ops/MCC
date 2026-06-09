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
  formatPortRate,
  smartLabel
} from './lib/format.js';
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

function compactModelName(name) {
  if (!name) return 'NO MODEL';
  return name.replace(/^qwen/i, 'Qwen').replace(/-/g, ' ');
}

function TopBar({ status, modelStatus }) {
  const [view, setView] = useDashboardView();
  const deployStatus = useDeployStatus();
  const time = useMemo(() => {
    const now = status.updatedAt || new Date();
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(now);
  }, [status.updatedAt]);
  const deployTime = useMemo(() => {
    if (!deployStatus.deployedAt) return '--:--';
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(deployStatus.deployedAt));
  }, [deployStatus.deployedAt]);
  const deployOk = deployStatus.state === 'ok';
  return (
    <header className="topBar">
      <div className="brandMark">MAV-CONSOLE</div>
      <div className="clockBlock">
        <div>{time}</div>
        <span>{status.state === 'online' ? 'PROMETHEUS ONLINE' : status.state.toUpperCase()}</span>
      </div>
      <div className={`deployStatus ${deployOk ? 'online' : 'offline'}`}>
        <strong>{deployOk ? 'DEPLOY OK' : 'DEPLOY ...'}</strong>
        <span>{deployTime}</span>
      </div>
      <nav className="viewToggle" aria-label="Dashboard view">
        <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}>Home</button>
        <button className={view === 'hardware' ? 'active' : ''} onClick={() => setView('hardware')}>Hardware</button>
        <button className={view === 'network' ? 'active' : ''} onClick={() => setView('network')}>Network Map</button>
        <button className={view === 'orchestrator' ? 'active' : ''} onClick={() => setView('orchestrator')}>Orchestrator</button>
      </nav>
      <div className={`agentStatus ${modelStatus.state === 'online' ? 'online' : 'offline'}`}>
        LOCAL MODEL: <strong>{compactModelName(modelStatus.model)}</strong>
        <em>|</em>
        <span>{modelStatus.state.toUpperCase()}</span>
      </div>
    </header>
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
  const driveDUsed = diskUsedPercent(metrics.pcDriveDFreeBytes, metrics.pcDriveDTotalBytes, metrics.pcDriveD);
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
          smart={metrics.pcDriveCSmart}
        />
        <DriveBlock
          name="256GB WD-Black SN7100"
          mount="SECOND NVME"
          used={driveDUsed}
          freeBytes={metrics.pcDriveDFreeBytes}
          totalBytes={metrics.pcDriveDTotalBytes}
          smart={metrics.pcDriveDSmart}
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
          <em>HERMEN PROMPT QC</em>
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

function DriveBlock({ name, mount, used, freeBytes, totalBytes, smart }) {
  const safeUsed = used == null ? null : clampPercent(used);
  return (
    <div className="driveBlock">
      <div className="driveHead">
        <span>{name}</span>
        <strong className={smart === 0 ? 'bad' : smart === 1 ? 'ok' : ''}>{smartLabel(smart)}</strong>
      </div>
      <div className="driveMeta">
        <em>{mount}</em>
        <b>{safeUsed == null ? 'WAITING' : `${Math.round(safeUsed)}% USED`}</b>
      </div>
      <div className="miniBar driveUsage"><i style={{ width: `${safeUsed ?? 0}%` }} /></div>
      <div className="driveStats">
        <span>FREE {formatGbFromBytes(freeBytes)}</span>
        <span>TOTAL {formatGbFromBytes(totalBytes)}</span>
      </div>
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
      <div className="activePorts">ACTIVE PORTS | LINKING PORTS</div>
      <SwitchGraphic />
      <HardwareNetworkMap metrics={metrics} />
      <div className="networkStats">
        <div>
          <span>WAN DOWN</span>
          <strong>{metrics.wanDown?.toFixed?.(2) ?? '0.00'} Gb/s</strong>
        </div>
        <div>
          <span>PC RECEIVE</span>
          <strong>{metrics.pcNetIn?.toFixed?.(1) ?? '0.0'} Mb/s</strong>
        </div>
        <div>
          <span>DIRECT LINK</span>
          <strong className="direct-link-stat">{metrics.serverNetDirect?.toFixed?.(1) ?? '0.0'} Mb/s</strong>
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
  const gatewayRate = `${metrics.wanDown?.toFixed?.(2) ?? '0.00'} Gb/s`;
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
          ['DIRECT', 'Server ↔ PC', serverOnline && pcOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.serverNetDirect, metrics.pcNetDirect)],
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
  const data = metrics.dataDisk == null ? null : clampPercent(metrics.dataDisk);
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
        <div className="storageBlock">
          <h3>SERVER ROOT</h3>
          <p>(PROXMOX 256GB)</p>
          <div className="miniBar"><i style={{ width: `${root}%` }} /></div>
          <span>{Math.round(root)}% USED</span>
        </div>
        <div className="storageBlock future">
          <h3>SERVER DATA</h3>
          <p>(2TB WD-BLACK)</p>
          <div className="miniBar"><i style={{ width: `${data ?? 0}%` }} /></div>
          <span>{data == null ? 'WAITING FOR /data' : `${Math.round(data)}% USED`}</span>
        </div>
        <div className="storageBlock">
          <h3>MAIN PC C:</h3>
          <p>(1TB NVME)</p>
          <div className="miniBar"><i style={{ width: `${clampPercent(metrics.pcDrive)}%` }} /></div>
          <span>{Math.round(clampPercent(metrics.pcDrive))}% USED</span>
        </div>
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
  return (
    <div className="mapPage">
      <Panel title="LIVE NETWORK MAP" className="mapPanel">
        <div className="topologyCanvas">
          <div className="mapNode isp">
            <span>2.5Gb AT&T Fiber</span>
            <strong>ISP LINK</strong>
          </div>
          <div className="mapNode internet">
            <span>Internet</span>
            <strong>WAN</strong>
          </div>
          <div className="mapNode router">
            <span>Gateway Router</span>
            <strong>{metrics.wanDown?.toFixed?.(2) ?? '0.00'} Gb/s DOWN</strong>
          </div>
          <div className="mapNode switch">
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
            <span>Main Workstation</span>
            <strong>Port 3 / 2.5Gb</strong>
            <em>CPU {Math.round(clampPercent(metrics.pcCpu))}% / RAM {Math.round(clampPercent(metrics.pcRam))}%</em>
          </div>
          <div className={`mapNode serverNode ${serverOnline ? 'online' : 'offline'}`}>
            <span>HP ProDesk Server</span>
            <strong>Port 1 / 2.5Gb</strong>
            <em>CPU {Math.round(clampPercent(metrics.serverCpu))}% / RAM {Math.round(clampPercent(metrics.serverRam))}%</em>
          </div>
          <div className="mapNode meshNode">
            <span>x25 Deco Mesh</span>
            <strong>Port 2 / 1Gb</strong>
            <em>Wireless Clients</em>
          </div>

          <svg className="mapLines" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
            <path className={`staticLink ${gatewayClass}`} d="M500 62 L500 105" />
            <path className={`staticLink ${gatewayClass}`} d="M500 150 L500 205" />
            <path className={`staticLink ${gatewayClass}`} d="M500 220 L500 238" />
            <path className={`staticLink ${pcOnline ? pcClass : 'danger'}`} d="M393 346 L393 386 L205 386 L205 410" />
            <path className={`staticLink ${meshClass}`} d="M500 346 L500 438" />
            <path className={`staticLink ${serverOnline ? serverClass : 'danger'}`} d="M607 346 L607 386 L795 386 L795 410" />
            <path className={`flowLink ${gatewayClass}`} d="M500 62 L500 105" />
            <path className={`flowLink ${gatewayClass}`} d="M500 150 L500 205" />
            <path className={`flowLink ${gatewayClass}`} d="M500 220 L500 238" />
            <path className={`flowLink ${pcOnline ? pcClass : 'danger'}`} d="M393 346 L393 386 L205 386 L205 410" />
            <path className={`flowLink ${meshClass}`} d="M500 346 L500 438" />
            <path className={`flowLink ${serverOnline ? serverClass : 'danger'}`} d="M607 346 L607 386 L795 386 L795 410" />
            <path className={`staticLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 410 L795 410" />
            <path className={`flowLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 410 L795 410" />
          </svg>
        </div>
      </Panel>
      <Panel title="PORT MAP" className="portPanel">
        <div className="portRows">
          {[
            ['24', 'Gateway Router', 'ACTIVE', formatPortRate(metrics.switchPort24Rx, metrics.switchPort24Tx)],
            ['1', 'HP ProDesk Server', serverOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx)],
            ['2', 'x25 Deco Mesh', 'ACTIVE', formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx)],
            ['3', 'Main Workstation', pcOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx)],
            ['DIRECT', 'Server ↔ PC', serverOnline && pcOnline ? 'ACTIVE' : 'DOWN', formatPortRate(metrics.serverNetDirect, metrics.pcNetDirect)],
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
    'hermes-qwen': 'HERMES QWEN',
    'repo-bridge': 'REPO BRIDGE',
    'codex-review': 'CODEX REVIEW',
    'claude-cli': 'CLAUDE CLI',
    'rag-server': 'RAG SERVER'
  };
  return labels[workerId] || workerId?.toUpperCase?.() || 'UNROUTED';
}

function OrchestratorPage({ modelStatus }) {
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
      <Panel title="AI ORCHESTRATOR V1" className="orchestratorCommand">
        <form onSubmit={handlePlan}>
          <textarea
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            aria-label="Product idea"
          />
          <div className="orchestratorActions">
            <button type="submit" disabled={busy || modelStatus.state !== 'online'}>
              {busy ? 'Planning...' : 'Create Plan'}
            </button>
            <span>{modelStatus.state === 'online' ? `Lead worker online: ${compactModelName(modelStatus.model)}` : 'Local model offline'}</span>
          </div>
        </form>
      </Panel>

      <Panel title="WORKER ROUTER" className="workerRouter">
        <div className="workerGrid">
          {orchestratorStatus.workers.map((worker) => (
            <div className="workerCard" key={worker.id}>
              <span>{workerLabel(worker.id)}</span>
              <strong>{worker.role}</strong>
              <em>{worker.cost} / {worker.state}</em>
            </div>
          ))}
        </div>
      </Panel>

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
                    disabled={!['local-qwen', 'hermes-qwen'].includes(task.worker) || briefBusyId === task.id}
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

function HomePage({ modelStatus }) {
  const orchestratorStatus = useOrchestratorStatus();
  const seoWorkflow = useSeoWorkflow();
  const [actionQueue, setActionQueue] = useState(null);
  const [actionBusyId, setActionBusyId] = useState('');
  const [actionResult, setActionResult] = useState(null);
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
  const faults = [
    ...(seoWorkflow.faults || []),
    ...(actionQueue?.error ? [actionQueue.error] : []),
    ...(orchestratorStatus.error ? [orchestratorStatus.error] : [])
  ];
  const recentReports = reports
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 5);
  const activeWorkflow = seoWorkflow.activeWorkflow || {
    name: 'SEO Automation',
    phase: seoWorkflow.state || 'loading',
    reportsGenerated: reportsLast7Days.length
  };

  async function refreshActions() {
    try {
      setActionQueue(await querySeoActions());
    } catch (error) {
      setActionQueue((current) => ({ ...(current || {}), error: error.message }));
    }
  }

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

      <Panel title="RECENT REPORTS" className="reportsPanel">
        <div className="reportList">
          {recentReports.map((report) => (
            <div className="reportRow" key={report.name}>
              <strong>{report.name.replace(/_/g, ' ')}</strong>
              <span>{new Date(report.updatedAt).toLocaleString()}</span>
              <em>{report.displayTitle || report.headings?.[0] || report.summary?.[0] || 'Report ready'}</em>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="UPCOMING ACTIONS" className="actionsPanel">
        <div className="actionList">
          {upcomingActions.slice(0, 8).map((action) => (
            <div className="actionRow actionQueueRow" key={action.id}>
              <div>
                <strong>{action.title}</strong>
                <span>{action.status} / {action.platform} / {action.risk}</span>
                <em>{action.assigned_agent}</em>
              </div>
              <div className="actionButtons">
                <button type="button" disabled={actionBusyId === action.id} onClick={() => handleDryRunAction(action.id)}>
                  Dry Run
                </button>
                <button
                  type="button"
                  disabled={actionBusyId === action.id || action.status !== 'needs_approval' || !action.approval_required || Boolean(action.approval)}
                  onClick={() => handleApproveAction(action.id)}
                >
                  Approve
                </button>
              </div>
            </div>
          ))}
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

      <Panel title="FAULTS / BLOCKERS" className="faultPanel">
        <div className="faultList">
          {faults.length ? faults.map((fault) => <div className="faultRow" key={fault}>{fault}</div>) : <div className="clearState">No current workflow faults.</div>}
        </div>
      </Panel>

      <Panel title="RECENT TASK RUNS" className="recentTaskPanel">
        <div className="recentTaskList">
          {taskRuns.slice(0, 6).map((taskRun) => (
            <div className="recentTaskRow" key={taskRun.id}>
              <strong>{taskRun.taskTitle}</strong>
              <span>{workerLabel(taskRun.worker)} / {taskRun.status}</span>
            </div>
          ))}
          {!taskRuns.length ? <div className="emptyPlan">No task runs logged yet.</div> : null}
        </div>
      </Panel>
    </div>
  );
}

function App() {
  const modelStatus = useModelStatus();
  const orchestratorStatus = useOrchestratorStatus();
  const { metrics, status } = useMetrics();
  const [view, setView] = useState('home');
  return (
    <DashboardViewContext.Provider value={[view, setView]}>
      <main className="dashboard">
        <TopBar status={status} modelStatus={modelStatus} />
        {view === 'home' ? (
          <HomePage modelStatus={modelStatus} />
        ) : view === 'hardware' ? (
          <div className="mainGrid">
            <Workstation metrics={metrics} />
            <ModelOps metrics={metrics} modelStatus={modelStatus} orchestratorStatus={orchestratorStatus} />
            <Network metrics={metrics} />
            <Server metrics={metrics} />
            <Storage metrics={metrics} />
            <Services metrics={metrics} />
          </div>
        ) : view === 'network' ? (
          <NetworkMapPage metrics={metrics} />
        ) : (
          <OrchestratorPage modelStatus={modelStatus} />
        )}
        {status.error ? <div className="errorStrip">{status.error}</div> : null}
      </main>
    </DashboardViewContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
