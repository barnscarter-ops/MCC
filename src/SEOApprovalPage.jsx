import { useCallback, useEffect, useState } from 'react';
import { querySeoWorkflow, querySeoActions, approveSeoAction, runSeoAction, querySeoWeekPosts, api } from './lib/api.js';

const TYPE_LABEL = { seo_run: 'SEO RUN', website_task: 'WEBSITE TASK', social_post: 'SOCIAL POST' };
const STATE_COLOR = { pending_approval: '#f59e0b', needs_approval: '#f59e0b', approved: '#10b981', executing: '#6366f1', complete: '#10b981', error: '#ef4444', 'not-configured': '#6b7280' };

const POST_STATUS_COLOR = { posted: '#10b981', done: '#10b981', scheduled: '#06b6d4', approved: '#6366f1', pending_approval: '#f59e0b', posting: '#8b5cf6', error: '#ef4444' };
const POST_STATUS_LABEL = { posted: 'POSTED', done: 'POSTED', scheduled: 'SCHEDULED', approved: 'QUEUED', pending_approval: 'PENDING', posting: 'POSTING…', error: 'ERROR' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clean(str) {
  return (str || '').replace(/\*\*/g, '').trim();
}

function FacebookPromptModal({ isOpen, prompt, onApprove, onCancel, loading }) {
  if (!isOpen) return null;
  const [edited, setEdited] = useState(prompt);
  useEffect(() => setEdited(prompt), [prompt]);
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ background: '#161922', border: '1px solid #2a2f45', borderRadius: 10, padding: 32, maxWidth: 700, width: '90vw', maxHeight: '90vh', overflow: 'auto' }}>
        <h2 style={{ color: '#f1f5f9', marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 700 }}>Facebook Day 1 Video Prompt</h2>
        <p style={{ color: '#94a3b8', fontSize: 12, marginBottom: 16 }}>Review and approve the video generation prompt for Day 1, or edit it below.</p>
        <textarea
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          disabled={loading}
          style={{
            width: '100%', height: 200, padding: 12, borderRadius: 6, border: '1px solid #2a2f45',
            background: '#0f1117', color: '#f1f5f9', fontSize: 13, fontFamily: 'monospace',
            resize: 'vertical', marginBottom: 16, opacity: loading ? 0.6 : 1,
          }}
        />
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => onApprove(edited)}
            disabled={loading}
            style={{ flex: 1, padding: '10px 0', background: loading ? '#2a2f45' : '#10b981', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Approving...' : '✓ APPROVE PROMPT'}
          </button>
          <button
            onClick={onCancel}
            disabled={loading}
            style={{ flex: 1, padding: '10px 0', background: '#2a2f45', border: '1px solid #2a2f45', borderRadius: 6, color: '#94a3b8', fontSize: 13, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function WeekPostsSection({ weekPosts }) {
  const [tab, setTab] = useState('facebook');
  if (!weekPosts) return null;

  const posts = tab === 'facebook' ? weekPosts.facebook : weekPosts.gbp;
  const today = new Date().toISOString().slice(0, 10);

  const fbCount = weekPosts.facebook?.length || 0;
  const gbpCount = weekPosts.gbp?.length || 0;
  const fbPosted = weekPosts.facebook?.filter(p => p.status === 'posted' || p.status === 'done').length || 0;
  const gbpPosted = weekPosts.gbp?.filter(p => p.status === 'posted' || p.status === 'done').length || 0;
  const gbpScheduled = weekPosts.gbp?.filter(p => p.status === 'scheduled').length || 0;

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ borderTop: '1px solid #2a2f45', paddingTop: 24, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
          This Week's Posts
        </div>
        <div style={{ color: '#6b7280', fontSize: 11 }}>
          {weekPosts.week_start} – {weekPosts.week_end}
        </div>
      </div>

      {/* Platform tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'facebook', label: 'Facebook', count: fbCount, posted: fbPosted, label2: null },
          { key: 'gbp', label: 'Google Business', count: gbpCount, posted: gbpPosted, scheduled: gbpScheduled },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '7px 14px', borderRadius: 6, border: '1px solid',
            borderColor: tab === t.key ? '#6366f1' : '#2a2f45',
            background: tab === t.key ? '#6366f122' : 'transparent',
            color: tab === t.key ? '#818cf8' : '#6b7280',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {t.label}
            <span style={{ background: '#2a2f45', borderRadius: 10, padding: '1px 6px', fontSize: 10, color: '#94a3b8' }}>
              {t.scheduled != null
                ? `${t.posted} posted · ${t.scheduled} sched`
                : `${t.posted}/${t.count}`}
            </span>
          </button>
        ))}
      </div>

      {/* Posts grid */}
      {posts.length === 0 ? (
        <div style={{ color: '#6b7280', fontSize: 13, padding: '20px 0' }}>No posts scheduled this week.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {posts.map(post => {
            const isToday = post.post_date === today;
            const isPast = post.post_date < today;
            // For scheduled GBP posts: show urgency based on date
            let statusColor = POST_STATUS_COLOR[post.status] || (isPast ? '#ef4444' : '#6b7280');
            let statusLabel = POST_STATUS_LABEL[post.status] || (isPast ? 'MISSED?' : 'SCHEDULED');
            if (post.status === 'scheduled') {
              if (isToday) { statusColor = '#f59e0b'; statusLabel = 'POST TODAY'; }
              else if (isPast) { statusColor = '#ef4444'; statusLabel = 'OVERDUE'; }
            }
            const dateObj = new Date(post.post_date + 'T12:00:00');
            const dayLabel = DAYS[dateObj.getDay() === 0 ? 6 : dateObj.getDay() - 1];

            return (
              <div key={post.id} style={{
                background: isToday ? '#1e2235' : '#161922',
                border: `1px solid ${isToday ? '#6366f144' : '#2a2f45'}`,
                borderRadius: 7, padding: '10px 14px',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                {/* Day */}
                <div style={{ minWidth: 42, textAlign: 'center' }}>
                  <div style={{ color: isToday ? '#818cf8' : '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{dayLabel}</div>
                  <div style={{ color: isToday ? '#f1f5f9' : '#94a3b8', fontSize: 13, fontWeight: 600 }}>{post.post_date?.slice(5)}</div>
                </div>

                {/* Divider */}
                <div style={{ width: 1, height: 36, background: '#2a2f45', flexShrink: 0 }} />

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {clean(post.service) || clean(post.hook) || `Day ${post.day}`}
                  </div>
                  {post.hook && (
                    <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {clean(post.hook)}
                    </div>
                  )}
                </div>

                {/* Status */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                  <span style={{
                    background: statusColor + '22', color: statusColor,
                    border: `1px solid ${statusColor}44`, borderRadius: 4,
                    padding: '2px 7px', fontSize: 10, fontWeight: 700, letterSpacing: 1,
                  }}>{statusLabel}</span>
                  {post.posted_at && (
                    <span style={{ color: '#6b7280', fontSize: 10 }}>
                      {new Date(post.posted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {post.error && (
                    <span style={{ color: '#ef4444', fontSize: 10, maxWidth: 140, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={post.error}>
                      {post.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
  const [promptModal, setPromptModal] = useState({ isOpen: false, prompt: '', loading: false });

  const isFacebookPosts = action.type === 'social_post' && action.posts_count > 0 && action.label?.includes('Facebook');

  const handleApprove = async () => {
    if (isFacebookPosts) {
      setApproving(true);
      setResult(null);
      try {
        const response = await fetch(api('/api/workflows/seo/facebook/day1-prompt'), { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch prompt: ${response.status}`);
        const data = await response.json();
        setPromptModal({ isOpen: true, prompt: data.prompt, loading: false });
      } catch (err) {
        setResult({ ok: false, msg: err.message });
        setApproving(false);
      }
      return;
    }
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

  const handlePromptApprove = async (editedPrompt) => {
    setPromptModal({ ...promptModal, loading: true });
    try {
      const updateRes = await fetch(api('/api/workflows/seo/facebook/approve-prompt'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: editedPrompt }),
      });
      if (!updateRes.ok) throw new Error(`Failed to update prompt: ${updateRes.status}`);
      const approveRes = await approveSeoAction(action.id);
      setResult({ ok: true, msg: approveRes.message || 'Approved — bridge will execute shortly.' });
      setPromptModal({ isOpen: false, prompt: '', loading: false });
      onApprove?.();
    } catch (err) {
      setResult({ ok: false, msg: err.message });
      setPromptModal({ ...promptModal, loading: false });
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
    <>
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
      <FacebookPromptModal
        isOpen={promptModal.isOpen}
        prompt={promptModal.prompt}
        loading={promptModal.loading}
        onApprove={handlePromptApprove}
        onCancel={() => {
          setPromptModal({ isOpen: false, prompt: '', loading: false });
          setApproving(false);
        }}
      />
    </>
  );
}

export default function SEOApprovalPage() {
  const [workflow, setWorkflow] = useState(null);
  const [actions, setActions] = useState([]);
  const [weekPosts, setWeekPosts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const [wf, ac, wp] = await Promise.all([querySeoWorkflow(), querySeoActions(), querySeoWeekPosts()]);
      setWorkflow(wf);
      setActions(ac.actions || []);
      setWeekPosts(wp);
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
              { label: 'Pending Approval', value: pendingActions.length, color: '#f59e0b' },
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

          <WeekPostsSection weekPosts={weekPosts} />
        </>
      )}
    </div>
  );
}
