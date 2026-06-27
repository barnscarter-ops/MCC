// Home dashboard page (SEO workflow overview, action queue, reports, task runs),
// extracted from main.jsx.
import { useEffect, useState } from 'react';
import { useOrchestratorStatus, useSeoWorkflow } from '../hooks/useMetrics.js';
import { Panel } from '../components/Dashboard.jsx';
import { approveSeoAction, querySeoActions, runSeoAction } from '../lib/api.js';
import { workerLabel } from '../lib/dashboardHelpers.js';

const STATUS_BUCKETS = ['pending', 'in_process', 'completed', 'failed'];

export function HomePage({ modelStatus }) {
  const orchestratorStatus = useOrchestratorStatus();
  const seoWorkflow = useSeoWorkflow();
  const [actionQueue, setActionQueue] = useState(null);
  const [actionBusyId, setActionBusyId] = useState('');
  const [actionResult, setActionResult] = useState(null);
  const [listModal, setListModal] = useState(null);
  const [expandedSections, setExpandedSections] = useState(new Set());
  const [hoveredSection, setHoveredSection] = useState(null);
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
      const s = String(action.status || '').toLowerCase();
      // Active + recent failures: hide completed (collapsed separately).
      return STATUS_BUCKETS.includes(s) ? s !== 'completed' : true;
    })
    .sort((a, b) => {
      const rank = { failed: 0, in_process: 1, pending: 2, completed: 3 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    });
  const completedActions = actions.filter((a) => String(a.status).toLowerCase() === 'completed');
  const runHealth = seoWorkflow.runHealth || null;
  const failedPhases = runHealth
    ? Object.entries(runHealth).filter(([, v]) => v?.status === 'failed')
    : [];
  const bridgeAlerts = actionQueue?.alerts || [];
  const faults = [
    ...bridgeAlerts.map((al) => `${al.title}${al.detail ? ' — ' + al.detail : ''}`),
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

  const STATUS_BADGE = {
    pending: { label: 'PENDING', color: '#f59e0b' },
    in_process: { label: 'IN PROCESS', color: '#6366f1' },
    completed: { label: 'COMPLETED', color: '#10b981' },
    failed: { label: 'FAILED', color: '#ef4444' },
  };
  const PRIORITY_COLOR = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#6b7280' };
  const MEDIA_ICON = { video: '🎬 video', photo: '✅ photo', downgraded: '⚠️ photo (no video)', none: '⛔ no media' };

  function renderActionRow(action) {
    const isBusy = actionBusyId === action.id;
    const isApproved = action.status === 'pending' && Boolean(action.approval);
    const canApprove = action.status === 'pending' && action.approval_required && !action.approval;
    const canRunLive = Boolean(action.live_adapter) && isApproved;
    const canApproveAndRun = Boolean(action.live_adapter) && canApprove;
    const badge = STATUS_BADGE[action.status] || STATUS_BADGE.pending;
    const media = action.media_status && action.media_status !== 'n/a' ? MEDIA_ICON[action.media_status] : null;

    return (
      <div className="actionRow actionQueueRow" key={action.id}>
        <div>
          <strong>{action.title}</strong>
          <span className="actionDesc">{action.description}</span>
          <span>
            <em style={{ color: badge.color }}>{badge.label}</em>
            {' · '}<em style={{ color: PRIORITY_COLOR[action.priority] || '#6b7280' }}>{(action.priority || 'medium').toUpperCase()}</em>
            {' · '}{action.assigned_agent}
            {media ? <> {' · '}{media}</> : null}
          </span>
          {action.error ? <span className="actionError" title={action.error}>{action.error}</span> : null}
        </div>
        <div className="actionButtons">
          <button type="button" disabled={isBusy} onClick={() => handleDryRunAction(action.id)}>Dry Run</button>
          <button type="button" disabled={isBusy || !canApprove} onClick={() => handleApproveAction(action.id)}>Approve</button>
          <button type="button" disabled={isBusy || !canApproveAndRun} onClick={() => handleApproveAndRunAction(action.id)}>Approve + Run</button>
          <button type="button" disabled={isBusy || !canRunLive} onClick={() => handleLiveRunAction(action.id)}>Run Live</button>
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

  function toggleSection(key) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
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
      const result = await runSeoAction(actionId, '', '', false);
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
      const result = await runSeoAction(actionId, '', '', true);
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
      const run = await runSeoAction(actionId, '', '', true);
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
            <em className={onlineWorkers === workers.length && workers.length > 0 ? 'fleetOk' : 'fleetWarn'}>
              ● {onlineWorkers === workers.length && workers.length > 0 ? 'ALL ONLINE' : `${workers.length - onlineWorkers} OFFLINE`}
            </em>
          </div>
          <div>
            <span>7-DAY REPORTS</span>
            <strong>{reportsLast7Days.length}</strong>
            <em>{seoWorkflow.source === 'seo-app' ? 'SEO APP' : (seoWorkflow.state || 'UNKNOWN').toUpperCase()}</em>
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

      <Panel title="ACTIVITY" className="activityPanel">
        {/* Upcoming Actions */}
        <div className="activitySection">
          <div
            className="activitySectionHead"
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('actions')}
            onKeyDown={(e) => e.key === 'Enter' && toggleSection('actions')}
            onMouseEnter={() => setHoveredSection('actions')}
            onMouseLeave={() => setHoveredSection(null)}
          >
            <strong>UPCOMING ACTIONS</strong>
            <span className="activityCount">{upcomingActions.length}</span>
            <span className="activityChevron">{expandedSections.has('actions') ? '▲' : '▼'}</span>
            {hoveredSection === 'actions' && !expandedSections.has('actions') && upcomingActions.length > 0 && (
              <div className="activityPreview">
                {upcomingActions.slice(0, 2).map((a) => (
                  <div key={a.id}>{a.title} — {a.status}</div>
                ))}
                {upcomingActions.length > 2 && <div>+{upcomingActions.length - 2} more</div>}
              </div>
            )}
          </div>
          {expandedSections.has('actions') && (
            <div className="activitySectionBody">
              <div className="panelListToolbar">
                <span>{upcomingActions.length} total</span>
                <button type="button" disabled={upcomingActions.length <= 5} onClick={() => setListModal('actions')}>View all</button>
              </div>
              <div className="actionList compactList">
                {visibleActions.map(renderActionRow)}
                {completedActions.length > 0 ? (
                  <div className="completedCount">✓ {completedActions.length} completed (last 48h)</div>
                ) : null}
                {!upcomingActions.length ? <div className="emptyPlan">No upcoming actions detected.</div> : null}
                {actionResult ? (
                  <div className={actionResult.kind === 'error' ? 'actionResult error' : 'actionResult'}>
                    {actionResult.kind === 'error' ? actionResult.error : `${actionResult.kind}: ${actionResult.result.status || actionResult.result.state || 'complete'}`}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* Recent Reports */}
        <div className="activitySection">
          <div
            className="activitySectionHead"
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('reports')}
            onKeyDown={(e) => e.key === 'Enter' && toggleSection('reports')}
            onMouseEnter={() => setHoveredSection('reports')}
            onMouseLeave={() => setHoveredSection(null)}
          >
            <strong>RECENT REPORTS</strong>
            <span className="activityCount">{recentReports.length}</span>
            <span className="activityChevron">{expandedSections.has('reports') ? '▲' : '▼'}</span>
            {hoveredSection === 'reports' && !expandedSections.has('reports') && recentReports.length > 0 && (
              <div className="activityPreview">
                {recentReports.slice(0, 2).map((r) => (
                  <div key={r.name}>{(r.name || '').replace(/_/g, ' ')} — {new Date(r.updatedAt).toLocaleDateString()}</div>
                ))}
                {recentReports.length > 2 && <div>+{recentReports.length - 2} more</div>}
              </div>
            )}
          </div>
          {expandedSections.has('reports') && (
            <div className="activitySectionBody">
              <div className="panelListToolbar">
                <span>{recentReports.length} total</span>
                <button type="button" disabled={recentReports.length <= 5} onClick={() => setListModal('reports')}>View all</button>
              </div>
              <div className="reportList compactList">
                {visibleReports.map(renderReportRow)}
              </div>
            </div>
          )}
        </div>

        {/* Recent Task Runs */}
        <div className="activitySection">
          <div
            className="activitySectionHead"
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('tasks')}
            onKeyDown={(e) => e.key === 'Enter' && toggleSection('tasks')}
            onMouseEnter={() => setHoveredSection('tasks')}
            onMouseLeave={() => setHoveredSection(null)}
          >
            <strong>RECENT TASK RUNS</strong>
            <span className="activityCount">{taskRuns.length}</span>
            <span className="activityChevron">{expandedSections.has('tasks') ? '▲' : '▼'}</span>
            {hoveredSection === 'tasks' && !expandedSections.has('tasks') && taskRuns.length > 0 && (
              <div className="activityPreview">
                {taskRuns.slice(0, 2).map((t) => (
                  <div key={t.id}>{t.taskTitle} — {t.status}</div>
                ))}
                {taskRuns.length > 2 && <div>+{taskRuns.length - 2} more</div>}
              </div>
            )}
          </div>
          {expandedSections.has('tasks') && (
            <div className="activitySectionBody">
              <div className="panelListToolbar">
                <span>{taskRuns.length} total</span>
                <button type="button" disabled={taskRuns.length <= 5} onClick={() => setListModal('tasks')}>View all</button>
              </div>
              <div className="recentTaskList compactList">
                {visibleTaskRuns.map(renderTaskRunRow)}
                {!taskRuns.length ? <div className="emptyPlan">No task runs logged yet.</div> : null}
              </div>
            </div>
          )}
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
