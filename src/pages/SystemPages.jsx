// System status pages (workstation, AI core, network, server, network map),
// extracted from main.jsx. Presentational — driven entirely by the metrics prop.
import { Panel, Gauge, DriveBlock } from '../components/Dashboard.jsx';
import { clampPercent, diskUsedPercent, formatCompactNumber, formatGbFromBytes, formatPortRate } from '../lib/format.js';
import { formatWanDown, formatPcUpDown, compactModelName } from '../lib/dashboardHelpers.js';

// Network node/link color by TRAFFIC ACTIVITY (not resource health):
// link down → red (danger), online + data flowing → green (good), online + idle → dim grey (idle).
function trafficClass(online, rx, tx) {
  if (online === false) return 'danger';
  return Number(rx) > 0 || Number(tx) > 0 ? 'good' : 'idle';
}

export function Workstation({ metrics }) {
  const ramUsed = formatGbFromBytes(metrics.pcRamUsedBytes);
  const ramTotal = formatGbFromBytes(metrics.pcRamTotalBytes);
  const driveCUsed = diskUsedPercent(metrics.pcDriveCFreeBytes, metrics.pcDriveCTotalBytes, metrics.pcDrive);
  return (
    <Panel title="WORKSTATION: INTEL i5-13600K" className="workstation">
      <div className="gaugeRow pcGaugeRow">
        <Gauge label="CPU" value={metrics.pcCpu} sublabel="INTEL i5-13600K" warn={85} crit={95} />
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
          decimals={1}
          warn={80}
          crit={92}
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
          mount="E: ARCHIVE"
          totalBytes={256060514304}
          healthText="HEALTHY"
        />
        <DriveBlock
          name="1TB WD-Black SN7100"
          mount="D: STORAGE"
          totalBytes={1000204886016}
          healthText="HEALTHY"
        />
      </div>
      <div className="panelFooter">
        <span className={metrics.pcUp === 1 ? 'ok' : 'bad'}>{metrics.pcUp === 1 ? 'EXPORTER ONLINE' : 'EXPORTER DOWN'}</span>
        <span>PORT 3 / 2.5Gb</span>
      </div>
    </Panel>
  );
}

export function ModelOps({ metrics, modelStatus, orchestratorStatus }) {
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

export function Network({ metrics }) {
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

export function HardwareNetworkMap({ metrics }) {
  const pcOnline = metrics.pcUp === 1;
  const serverOnline = metrics.serverUp === 1;
  const pcClass = trafficClass(pcOnline, metrics.switchPort3Rx, metrics.switchPort3Tx);
  const serverClass = trafficClass(serverOnline, metrics.switchPort1Rx, metrics.switchPort1Tx);
  const meshClass = trafficClass(true, metrics.switchPort2Rx, metrics.switchPort2Tx);
  const gatewayClass = trafficClass(true, metrics.switchPort24Rx, metrics.switchPort24Tx);
  const gatewayRate = formatWanDown(metrics);
  return (
    <div className="hardwareNetworkMapPanel">
      <div className="hardwareTopology">
        <svg className="hardwareLines" viewBox="0 0 560 154" preserveAspectRatio="none" aria-hidden="true">
          <path className={`staticLink ${gatewayClass}`} d="M70 0 L70 58" />
          <path className={`staticLink ${pcClass}`} d="M210 0 L210 58" />
          <path className={`staticLink ${meshClass}`} d="M350 0 L350 58" />
          <path className={`staticLink ${serverClass}`} d="M490 0 L490 58" />
          <path className={`flowLink ${gatewayClass}`} d="M70 0 L70 58" />
          <path className={`flowLink ${pcClass}`} d="M210 0 L210 58" />
          <path className={`flowLink ${meshClass}`} d="M350 0 L350 58" />
          <path className={`flowLink ${serverClass}`} d="M490 0 L490 58" />
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
          <em>{pcOnline ? formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx) : 'LINK DOWN'}</em>
        </div>
        <div className="topoDevice meshDevice">
          <span>x25 Deco Mesh</span>
          <strong>Port 2 / 1Gb</strong>
          <em>{formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx)}</em>
        </div>
        <div className={`topoDevice serverDevice ${serverOnline ? 'online' : 'offline'}`}>
          <span>HP ProDesk Server</span>
          <strong>Port 1 / 2.5Gb</strong>
          <em>{serverOnline ? formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx) : 'LINK DOWN'}</em>
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

export function Server({ metrics }) {
  const serverOnline = Number(metrics.serverUp) === 1;
  const pcOnline = metrics.pcUp === 1;
  const root = clampPercent(metrics.rootDisk);
  const localLvmUsed = diskUsedPercent(metrics.pveLocalLvmFreeBytes, metrics.pveLocalLvmTotalBytes, null);
  const samsungSataUsed = diskUsedPercent(metrics.samsungSataFreeBytes, metrics.samsungSataTotalBytes, null);
  const services = [
    ['PROMETHEUS', 'ONLINE'],
    ['MAV-CONSOLE', 'ONLINE'],
    ['MAIN PC', pcOnline ? 'ONLINE' : 'DOWN'],
    ['PROXMOX', serverOnline ? 'ONLINE' : 'DOWN'],
    ['LOCAL MODEL', 'TRACKED']
  ];
  return (
    <Panel title="HP ProDesk RAG SERVER (PROXMOX)" className="server">
      <div className="serverGrid">
        <div className={`statusOrb ${serverOnline ? 'online' : 'offline'}`}>
          <span>NODE</span>
          <strong>{serverOnline ? 'UP' : 'DOWN'}</strong>
        </div>
        <Gauge label="SERVER CPU" value={metrics.serverCpu} compact warn={85} crit={95} />
        <Gauge label="RAM" value={metrics.serverRam} compact warn={80} crit={92} />
        <Gauge label="ROOT DISK" value={metrics.rootDisk} compact color="#7ac177" />
      </div>
      <div className="parseLine">
        <span>PROXMOX EXPORTER STATUS:</span>
        <strong>{serverOnline ? 'ONLINE' : 'OFFLINE'}</strong>
      </div>
      <div className="healthBar">
        <span>STORAGE SYSTEM HEALTH</span>
        <div><i style={{ width: '98%' }} /></div>
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
      <div className="serviceList">
        {services.map(([name, state]) => (
          <div className="serviceRow" key={name}>
            <span className={state === 'DOWN' ? 'led red' : 'led'} />
            <strong>{name}</strong>
            <em>{state}</em>
          </div>
        ))}
      </div>
      <div className="panelFooter">
        <span className={serverOnline ? 'ok' : 'bad'}>{serverOnline ? 'NODE_EXPORTER ONLINE' : 'NODE_EXPORTER DOWN'}</span>
        <span>PORT 1 / 2.5Gb</span>
      </div>
    </Panel>
  );
}

export function NetworkMapPage({ metrics }) {
  const pcOnline = metrics.pcUp === 1;
  const serverOnline = metrics.serverUp === 1;
  const pcClass = trafficClass(pcOnline, metrics.switchPort3Rx, metrics.switchPort3Tx);
  const serverClass = trafficClass(serverOnline, metrics.switchPort1Rx, metrics.switchPort1Tx);
  const gatewayClass = trafficClass(true, metrics.switchPort24Rx, metrics.switchPort24Tx);
  const meshClass = trafficClass(true, metrics.switchPort2Rx, metrics.switchPort2Tx);
  const gatewayRate = formatWanDown(metrics);
  return (
    <div className="mapPage">
      <Panel title="LIVE NETWORK MAP" className="mapPanel">
        <div className="topologyCanvas">
          {/* Tier zone labels */}
          <div className="tierChip" style={{top: 12, left: 14}}>WAN / INTERNET</div>
          <div className="tierChip" style={{top: 282, left: 14}}>SWITCH CORE</div>
          <div className="tierChip" style={{top: 428, left: 14}}>ENDPOINTS</div>
          {/* Horizontal tier dividers */}
          <div className="tierDivider" style={{top: 278}} />
          <div className="tierDivider" style={{top: 424}} />
          {/* Link speed labels */}
          <div className="linkLabel" style={{top: 88, left: 'calc(50% + 120px)'}}>AT&T FIBER</div>
          <div className="linkLabel" style={{top: 172, left: 'calc(50% + 120px)'}}>WAN UPLINK</div>
          <div className="linkLabel" style={{top: 258, left: 'calc(50% + 120px)'}}>GW → CORE</div>
          <div className="linkLabel" style={{top: 412, left: '28%'}}>P3 · 2.5 Gb</div>
          <div className="linkLabel" style={{top: 412, left: 'calc(50% + 120px)'}}>P2 · 1 Gb</div>
          <div className="linkLabel" style={{top: 412, right: '14%'}}>P1 · 2.5 Gb</div>

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
            <em>{pcOnline ? formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx) : 'LINK DOWN'}</em>
          </div>
          <div className={`mapNode serverNode ${serverOnline ? 'online' : 'offline'}`}>
            <span className="nodeTypeBadge">SERVER</span>
            <span>Proxmox Server</span>
            <strong>Port 1 · 2.5 Gb</strong>
            <em>{serverOnline ? formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx) : 'LINK DOWN'}</em>
          </div>
          <div className="mapNode meshNode">
            <span className="nodeTypeBadge">WIRELESS AP</span>
            <span>x25 Deco Mesh</span>
            <strong>Port 2 · 1 Gb</strong>
            <em>{formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx)}</em>
          </div>

          <svg className="mapLines" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden="true">
            {/* ISP → Internet */}
            <path className={`staticLink ${gatewayClass}`} d="M500 72 L500 90" />
            <path className={`flowLink ${gatewayClass}`} d="M500 72 L500 90" />
            {/* Internet → Router */}
            <path className={`staticLink ${gatewayClass}`} d="M500 141 L500 161" />
            <path className={`flowLink ${gatewayClass}`} d="M500 141 L500 161" />
            {/* Router → Switch */}
            <path className={`staticLink ${gatewayClass}`} d="M500 217 L500 240" />
            <path className={`flowLink ${gatewayClass}`} d="M500 217 L500 240" />
            {/* Switch → Workstation */}
            <path className={`staticLink ${pcOnline ? pcClass : 'danger'}`} d="M393 336 L393 350 L205 350 L205 361" />
            <path className={`flowLink ${pcOnline ? pcClass : 'danger'}`} d="M393 336 L393 350 L205 350 L205 361" />
            {/* Switch → Mesh */}
            <path className={`staticLink ${meshClass}`} d="M500 336 L500 361" />
            <path className={`flowLink ${meshClass}`} d="M500 336 L500 361" />
            {/* Switch → Server */}
            <path className={`staticLink ${serverOnline ? serverClass : 'danger'}`} d="M607 336 L607 350 L795 350 L795 361" />
            <path className={`flowLink ${serverOnline ? serverClass : 'danger'}`} d="M607 336 L607 350 L795 350 L795 361" />
            {/* Workstation ↔ Server LAN segment — U-route below endpoints */}
            <path className={`staticLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 427 L205 448 L795 448 L795 427" />
            <path className={`flowLink ${serverOnline && pcOnline ? 'good' : 'danger'}`} d="M205 427 L205 448 L795 448 L795 427" />
          </svg>
        </div>
      </Panel>
      <Panel title="PORT MAP" className="portPanel">
        <div className="portRows">
          {[
            ['24', 'Gateway Router', 'ACTIVE', formatPortRate(metrics.switchPort24Rx, metrics.switchPort24Tx, '1 Gb link')],
            ['1', 'Proxmox Server', serverOnline ? 'ACTIVE' : 'DOWN', serverOnline ? formatPortRate(metrics.switchPort1Rx, metrics.switchPort1Tx, '2.5 Gb link') : '—'],
            ['2', 'x25 Deco Mesh', 'ACTIVE', formatPortRate(metrics.switchPort2Rx, metrics.switchPort2Tx, '1 Gb link')],
            ['3', 'Workstation', pcOnline ? 'ACTIVE' : 'DOWN', pcOnline ? formatPortRate(metrics.switchPort3Rx, metrics.switchPort3Tx, '2.5 Gb link') : '—'],
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
