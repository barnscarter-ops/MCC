import { useEffect, useState, useCallback } from 'react';
import { supabase, isSupabaseAvailable } from './supabase';

const PRIORITY_COLOR = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#6b7280' };
const STATUS_COLOR = { pending_approval: '#f59e0b', approved: '#10b981', posting: '#6366f1', posted: '#10b981', scheduled: '#10b981', error: '#ef4444', done: '#10b981' };

function Badge({ label, color }) {
  return (
    <span style={{ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
      {label}
    </span>
  );
}

function PostCard({ post }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ background: '#1e2130', border: '1px solid #2a2f45', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: expanded ? 10 : 0 }}>
        <Badge label={post.platform} color={post.platform === 'facebook' ? '#6366f1' : '#10b981'} />
        <Badge label={post.type || 'post'} color="#6b7280" />
        {post.day && <span style={{ color: '#6b7280', fontSize: 12 }}>Day {post.day}</span>}
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{post.post_date}</span>
        <span style={{ color: '#f1f5f9', fontWeight: 600, flex: 1, minWidth: 80, fontSize: 13 }}>{post.service}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Badge label={post.status} color={STATUS_COLOR[post.status] || '#6b7280'} />
          <button onClick={() => setExpanded(e => !e)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          {post.hook && <p style={{ color: '#f1f5f9', fontWeight: 600, margin: '8px 0 4px' }}>{post.hook}</p>}
          {post.body && <p style={{ margin: '4px 0' }}>{post.body}</p>}
          {post.cta && <p style={{ color: '#10b981', margin: '4px 0' }}>{post.cta}</p>}
          {post.hashtags && <p style={{ color: '#6366f1', margin: '4px 0', fontSize: 12 }}>{post.hashtags}</p>}
          {post.photo_file && <p style={{ margin: '4px 0' }}>📷 {post.photo_file}</p>}
          {post.video_prompt && <p style={{ margin: '4px 0', fontStyle: 'italic' }}>🎬 {post.video_prompt.slice(0, 120)}...</p>}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task }) {
  return (
    <div style={{ background: '#1e2130', border: `1px solid ${PRIORITY_COLOR[task.priority] || '#2a2f45'}44`, borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Badge label={task.priority} color={PRIORITY_COLOR[task.priority] || '#6b7280'} />
        <Badge label={(task.type || 'task').replace('_', ' ')} color="#6b7280" />
        <span style={{ color: '#f1f5f9', fontWeight: 600, flex: 1, fontSize: 13 }}>{task.title}</span>
        <Badge label={task.status} color={STATUS_COLOR[task.status] || '#6b7280'} />
      </div>
      {task.description && <p style={{ color: '#6b7280', fontSize: 12, margin: 0, lineHeight: 1.5 }}>{task.description.slice(0, 200)}</p>}
    </div>
  );
}

function CompletedTaskCard({ task }) {
  return (
    <div style={{ background: '#1e2130', border: '1px solid #10b98133', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: task.description ? 6 : 0 }}>
        <span style={{ color: '#10b981', fontSize: 16 }}>✓</span>
        <Badge label={task.task_id || 'task'} color="#10b981" />
        <span style={{ color: '#f1f5f9', fontWeight: 600, flex: 1, fontSize: 13 }}>{task.title}</span>
        <span style={{ color: '#6b7280', fontSize: 11 }}>{task.completed_at ? new Date(task.completed_at).toLocaleDateString() : task.created_at ? new Date(task.created_at).toLocaleDateString() : ''}</span>
      </div>
      {task.description && <p style={{ color: '#6b7280', fontSize: 12, margin: 0, lineHeight: 1.5 }}>{task.description.slice(0, 200)}</p>}
    </div>
  );
}

export default function SEOApprovalPage() {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [posts, setPosts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [completedTasks, setCompletedTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [tab, setTab] = useState('facebook');

  const loadRuns = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('seo_runs').select('*').order('created_at', { ascending: false }).limit(5);
    setRuns(data || []);
    if (data?.length && !selectedRun) setSelectedRun(data[0]);
    setLoading(false);
  }, [selectedRun]);

  const loadRunData = useCallback(async (run) => {
    if (!supabase || !run) return;
    const [postsRes, tasksRes] = await Promise.all([
      supabase.from('weekly_posts').select('*').eq('run_id', run.id).order('platform').order('day'),
      supabase.from('website_tasks').select('*').eq('run_id', run.id).order('priority'),
    ]);
    setPosts(postsRes.data || []);
    setTasks(tasksRes.data || []);
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { if (selectedRun) loadRunData(selectedRun); }, [selectedRun, loadRunData]);

  // Load completed tasks log (all runs, all time)
  useEffect(() => {
    if (!supabase) return;
    supabase.from('website_tasks').select('id,title,description,details,updated_at,created_at,run_id')
      .eq('status', 'done').order('updated_at', { ascending: false }).limit(50)
      .then(({ data }) => setCompletedTasks((data || []).map(t => ({
        ...t,
        task_id: (t.details && typeof t.details === 'object') ? t.details.task_id : null,
        completed_at: t.updated_at,
      }))));
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase.channel('mcc-approvals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seo_runs' }, () => loadRuns())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_posts' }, () => { if (selectedRun) loadRunData(selectedRun); })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [selectedRun, loadRuns, loadRunData]);

  const approve = async () => {
    if (!selectedRun || approving) return;
    setApproving(true);
    await supabase.from('seo_runs').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', selectedRun.id);
    await supabase.from('weekly_posts').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('run_id', selectedRun.id).eq('status', 'pending_approval');
    await supabase.from('website_tasks').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('run_id', selectedRun.id).eq('status', 'pending_approval');
    await loadRuns();
    await loadRunData(selectedRun);
    setApproving(false);
  };

  if (!isSupabaseAvailable) return (
    <div style={{ padding: 40, color: '#6b7280', textAlign: 'center' }}>
      <p>Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.</p>
    </div>
  );

  const fbPosts = posts.filter(p => p.platform === 'facebook');
  const gbpPosts = posts.filter(p => p.platform === 'gbp');
  const isPending = selectedRun?.status === 'pending_approval';
  const isExecuting = ['approved', 'executing'].includes(selectedRun?.status);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ color: '#f1f5f9', margin: 0, fontSize: 22, fontWeight: 700 }}>SEO Pipeline</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Review and approve weekly content before it posts</p>
        </div>
        {selectedRun && (
          <Badge label={(selectedRun.status || 'unknown').replace(/_/g, ' ')} color={STATUS_COLOR[selectedRun.status] || '#6b7280'} />
        )}
      </div>

      {/* Run selector */}
      {runs.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {runs.map(r => (
            <button key={r.id} onClick={() => setSelectedRun(r)} style={{ background: selectedRun?.id === r.id ? '#6366f1' : '#1e2130', border: '1px solid #2a2f45', borderRadius: 6, color: '#f1f5f9', padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}>
              Week of {r.week_of}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#6b7280', textAlign: 'center', padding: 60 }}>Loading...</div>
      ) : !selectedRun ? (
        <div style={{ color: '#6b7280', textAlign: 'center', padding: 60 }}>No runs found. The pipeline hasn't run yet.</div>
      ) : (
        <>
          {/* Stats bar */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Facebook Posts', count: fbPosts.length, color: '#6366f1' },
              { label: 'GBP Posts', count: gbpPosts.length, color: '#10b981' },
              { label: 'Website Tasks', count: tasks.length, color: '#f59e0b' },
            ].map(s => (
              <div key={s.label} style={{ background: '#1e2130', border: '1px solid #2a2f45', borderRadius: 8, padding: '12px 20px', flex: 1, textAlign: 'center' }}>
                <div style={{ color: s.color, fontSize: 24, fontWeight: 700 }}>{s.count}</div>
                <div style={{ color: '#6b7280', fontSize: 12 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Approve button */}
          {isPending && (
            <button onClick={approve} disabled={approving} style={{ width: '100%', padding: '14px', marginBottom: 24, background: approving ? '#2a2f45' : '#10b981', border: 'none', borderRadius: 8, color: '#fff', fontSize: 15, fontWeight: 700, cursor: approving ? 'not-allowed' : 'pointer', letterSpacing: 0.5 }}>
              {approving ? 'Approving...' : '✓ APPROVE & LAUNCH — Post Day 1 + Schedule Week'}
            </button>
          )}
          {isExecuting && (
            <div style={{ background: '#10b98122', border: '1px solid #10b98144', borderRadius: 8, padding: 14, marginBottom: 24, color: '#10b981', textAlign: 'center', fontWeight: 600 }}>
              ✓ Approved — bridge is executing... posts will appear shortly
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #2a2f45' }}>
            {[['facebook', `Facebook (${fbPosts.length})`], ['gbp', `GBP (${gbpPosts.length})`], ['tasks', `Website Tasks (${tasks.length})`], ['history', `Completed (${completedTasks.length})`]].map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} style={{ background: 'none', border: 'none', borderBottom: tab === key ? '2px solid #6366f1' : '2px solid transparent', color: tab === key ? '#f1f5f9' : '#6b7280', padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: tab === key ? 600 : 400 }}>
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          {tab === 'facebook' && fbPosts.map(p => <PostCard key={p.id} post={p} />)}
          {tab === 'gbp' && gbpPosts.map(p => <PostCard key={p.id} post={p} />)}
          {tab === 'tasks' && tasks.map(t => <TaskCard key={t.id} task={t} />)}
          {tab === 'history' && (
            completedTasks.length === 0
              ? <div style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No completed tasks yet.</div>
              : completedTasks.map(t => <CompletedTaskCard key={t.id} task={t} />)
          )}
        </>
      )}
    </div>
  );
}
