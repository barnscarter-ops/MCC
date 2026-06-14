import { useCallback, useEffect, useState } from 'react';
import { querySeoWorkflow, querySeoActions, approveSeoAction, runSeoAction } from './lib/api.js';

const TYPE_LABEL = { seo_run: 'SEO RUN', website_task: 'WEBSITE TASK', social_post: 'SOCIAL POST' };
const STATE_COLOR = { pending_approval: '#f59e0b', needs_approval: '#f59e0b', approved: '#10b981', executing: '#6366f1', complete: '#10b981', error: '#ef4444', 'not-configured': '#6b7280' };

function StatusBadge({ label, color }) {
  return (
    <span style={{ background: (color || '#6b7280') + '22', color: color || '#6b7280', border: `1px solid ${color || '#6b7280'}44`, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function ActionCard({ action, onApprove, onRun, busy }) {
  const [approving, setApproving] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const handleApprove = async () => {
    setApproving(true);
    setResult(null);
    try {
      const res = await approveSeoAction(action.id);
      setResult({ ok: true, msg: res.message || 'Approved — bridge will execute shortly.' });
      onApprove?.();
    } catch (err) {
      setResult({ ok: false, msg: err.message });
    } finally {
      setApproving(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await runSeoAction(action.id, true);
      setResult({ ok: true, msg: res.message || 'Triggered.' });
      onRun?.();
    } catch (err) {
      setResult({ ok: false, msg: err.message });
    } finally {
      setRunning(false);
    }
  };

  const isPending = action.status === 'needs_approval' || action.status === 'pending_approval';
  const color = STATE_COLOR[action.status] || '#6b7280';

  return (
    <div style={{ background: '#1a1d26', border: `1px solid ${isPending ? '#f59e0b33' : '#2a2f45'}`, borderRadius: 8, padding: '14px 18px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusBadge label={TYPE_LABEL[action.type] || action.type} color="#6b7280" />
        <span style={{ color: '#f1f5f9', fontWeight: 600, flex: 1, fontSize: 14 }}>{action.label}</span>
        {action.posts_count != null && (
          <span style={{ color: '#6b7280', fontSize: 12 }}>{action.posts_count} posts</span>
        )}
        <StatusBadge label={(action.status || '').replace(/_/g, ' ')} color={color} />
      </div>

      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={handleApprove}
            disabled={approving || running || busy}
            style={{ flex: 1, padding: '9px 0', background: approving ? '#2a2f45' : '#10b981', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 700, cursor: approving ? 'not-allowed' : 'pointer' }}
          >
            {approving ? 'Approving...' : '✓ APPROVE'}
          </button>
          <button
            onClick={handleRun}
            disabled={approving || running || busy}
            style={{ flex: 1, padding: '9px 0', background: running ? '#2a2f45' : '#6366f1', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer' }}
          >
            {running ? 'Running...' : '▶ RUN NOW'}
          </button>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 8, padding: '6px 10px', background: result.ok ? '#10b98122' : '#ef444422', border: `1px solid ${result.ok ? '#10b98144' : '#ef444444'}`, borderRadius: 5, color: result.ok ? '#10b981' : '#ef4444', fontSize: 12 }}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </div>
      )}
    </div>
  );
}

export default function SEOApprovalPage() {
  const [workflow, setWorkflow] = useState(null);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const [wf, ac] = await Promise.all([querySeoWorkflow(), querySeoActions()]);
      setWorkflow(wf);
      setActions(ac.actions || []);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const stateColor = STATE_COLOR[workflow?.state] || '#6b7280';
  const pendingActions = actions.filter(a => a.status === 'needs_approval' || a.status === 'pending_approval');
  const otherActions = actions.filter(a => a.status !== 'needs_approval' && a.status !== 'pending_approval');

  return (
    <div style={{ padding: '24px 32px', maxWidth: 860, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12 }}>
        <div>
          <h1 style={{ color: '#f1f5f9', margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>SEO Pipeline</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 12 }}>
            Review and approve weekly content before it posts
            {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>
        {workflow && (
          <StatusBadge label={(workflow.state || 'unknown').replace(/-/g, ' ')} color={stateColor} />
        )}
      </div>

      {loading && (
        <div style={{ color: '#6b7280', textAlign: 'center', padding: 60 }}>Loading pipeline status...</div>
      )}

      {error && (
        <div style={{ background: '#ef444422', border: '1px solid #ef444444', borderRadius: 8, padding: '12px 16px', color: '#ef4444', marginBottom: 20 }}>
          ✗ {error}
        </div>
      )}

      {!loading && !error && workflow && (
        <>
          {/* Summary bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
            {[
              { label: 'Pending Approval', value: workflow.workflowStatus?.actions?.summary?.needs_approval ?? pendingActions.length, color: '#f59e0b' },
              { label: 'Reports Generated', value: workflow.activeWorkflow?.reportsGenerated ?? 0, color: '#10b981' },
              { label: 'Faults', value: (workflow.faults || []).length, color: '#ef4444' },
            ].map(s => (
              <div key={s.label} style={{ background: '#1a1d26', border: '1px solid #2a2f45', borderRadius: 8, padding: '12px 18px', flex: 1, textAlign: 'center' }}>
                <div style={{ color: s.color, fontSize: 22, fontWeight: 700 }}>{s.value}</div>
                <div style={{ color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Faults */}
          {(workflow.faults || []).length > 0 && (
            <div style={{ background: '#ef444411', border: '1px solid #ef444433', borderRadius: 8, padding: '10px 14px', marginBottom: 20 }}>
              {workflow.faults.map((f, i) => (
                <div key={i} style={{ color: '#ef4444', fontSize: 12, marginBottom: i < workflow.faults.length - 1 ? 4 : 0 }}>⚠ {f}</div>
              ))}
            </div>
          )}

          {/* Pending actions */}
          {pendingActions.length > 0 && (
            <>
              <div style={{ color: '#f59e0b', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
                Awaiting Approval ({pendingActions.length})
              </div>
              {pendingActions.map(action => (
                <ActionCard key={action.id} action={action} onApprove={load} onRun={load} />
              ))}
            </>
          )}

          {/* Other actions */}
          {otherActions.length > 0 && (
            <>
              <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', margin: '20px 0 10px' }}>
                Other Actions ({otherActions.length})
              </div>
              {otherActions.map(action => (
                <ActionCard key={action.id} action={action} onApprove={load} onRun={load} />
              ))}
            </>
          )}

          {pendingActions.length === 0 && otherActions.length === 0 && (
            <div style={{ color: '#6b7280', textAlign: 'center', padding: 60 }}>
              No pending actions. Pipeline is idle or already approved.
            </div>
          )}

          {/* Workflow phase */}
          {workflow.activeWorkflow && (
            <div style={{ marginTop: 24, borderTop: '1px solid #2a2f45', paddingTop: 16, display: 'flex', gap: 16, color: '#6b7280', fontSize: 12 }}>
              <span><strong style={{ color: '#94a3b8' }}>Workflow:</strong> {workflow.activeWorkflow.name}</span>
              <span><strong style={{ color: '#94a3b8' }}>Phase:</strong> {(workflow.activeWorkflow.phase || '').replace(/_/g, ' ')}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
