import { useEffect, useRef, useState } from 'react';
import { FALLBACK } from '../config/metrics.js';
import { queryAllMetrics, queryDeployStatus, queryModelStatus, queryOrchestratorStatus, querySeoWorkflow } from '../lib/api.js';
import { supabase } from '../supabase.js';

async function fetchNodeStatusField(field) {
  if (!supabase) return null;
  const { data } = await supabase
    .from('node_status')
    .select(field)
    .eq('node_id', 'homelab')
    .single();
  return data?.[field] ?? null;
}

export function useMetrics() {
  const [metrics, setMetrics] = useState(FALLBACK);
  const [status, setStatus] = useState({ state: 'loading', updatedAt: null, error: null, source: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const entries = await queryAllMetrics();
        if (cancelled) return;
        const hasData = entries.some(([, v]) => v !== null);
        if (!hasData) throw new Error('no data');
        const next = { ...FALLBACK };
        for (const [key, value] of entries) next[key] = value;
        setMetrics(next);
        setStatus({ state: 'online', updatedAt: new Date(), error: null, source: 'local' });
      } catch {
        if (!cancelled) setStatus(s => s.source === 'local' ? { ...s, source: null } : s);
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!supabase) return;

    async function fetchFromSupabase() {
      const { data } = await supabase
        .from('metrics')
        .select('values, updated_at')
        .eq('node_id', 'homelab')
        .single();
      if (!data) return;
      const next = { ...FALLBACK };
      for (const [key, value] of Object.entries(data.values || {})) {
        if (value !== null && value !== undefined) next[key] = value;
      }
      setMetrics(next);
      setStatus(s => s.source === 'local' ? s : { state: 'online', updatedAt: new Date(data.updated_at), error: null, source: 'supabase' });
    }

    fetchFromSupabase();

    const channel = supabase.channel('metrics-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'metrics', filter: 'node_id=eq.homelab' },
        payload => {
          const next = { ...FALLBACK };
          for (const [key, value] of Object.entries(payload.new?.values || {})) {
            if (value !== null && value !== undefined) next[key] = value;
          }
          setMetrics(next);
          setStatus(s => s.source === 'local' ? s : { state: 'online', updatedAt: new Date(payload.new?.updated_at), error: null, source: 'supabase' });
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  return { metrics, status };
}

export function useModelStatus() {
  const [modelStatus, setModelStatus] = useState({
    state: 'loading', model: null, contextTokens: null, parameterCount: null, error: null
  });
  const localWorking = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await queryModelStatus();
        if (cancelled) return;
        localWorking.current = true;
        setModelStatus({ ...next, error: null });
      } catch {
        if (cancelled) return;
        localWorking.current = false;
        // try supabase
        try {
          const data = await fetchNodeStatusField('model_status');
          if (data && !cancelled) setModelStatus(s => ({ ...s, ...data }));
        } catch { /* ignore */ }
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return modelStatus;
}

export function useDeployStatus() {
  const [deployStatus, setDeployStatus] = useState({
    state: 'loading', deployedAt: null, error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await queryDeployStatus();
        if (!cancelled) setDeployStatus({ ...next, error: null });
      } catch {
        if (cancelled) return;
        try {
          const data = await fetchNodeStatusField('deploy_status');
          if (data && !cancelled) setDeployStatus(s => ({ ...s, ...data }));
        } catch { /* ignore */ }
      }
    }
    load();
    const timer = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return deployStatus;
}

export function useOrchestratorStatus() {
  const [orchestratorStatus, setOrchestratorStatus] = useState({
    workers: [], runs: [], taskRuns: [], updatedAt: null, error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await queryOrchestratorStatus();
        if (!cancelled) setOrchestratorStatus({ ...next, error: null });
      } catch {
        if (cancelled) return;
        try {
          const data = await fetchNodeStatusField('orchestrator_status');
          if (data && !cancelled) setOrchestratorStatus(s => ({ ...s, ...data }));
        } catch { /* ignore */ }
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return orchestratorStatus;
}

async function fetchSeoFromSupabase() {
  if (!supabase) throw new Error('no supabase');
  const [runsRes, postsRes, tasksRes] = await Promise.all([
    supabase.from('seo_runs').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('weekly_posts').select('platform,status,service').order('created_at', { ascending: false }).limit(100),
    supabase.from('website_tasks').select('status').eq('status', 'pending_approval').limit(100),
  ]);
  const runs = runsRes.data || [];
  const posts = postsRes.data || [];
  const pendingTaskCount = (tasksRes.data || []).length;
  const latest = runs[0] || null;

  const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0 };
  for (const r of runs) {
    if (r.status === 'done') statusCounts.complete++;
    else if (r.status === 'posting' || r.status === 'posted') statusCounts.partial++;
    else if (r.status === 'error') statusCounts.blocked++;
    else statusCounts.incomplete++;
  }

  const pendingPosts = posts.filter(p => p.status === 'pending_approval');
  const actionSummary = {
    needs_approval: pendingPosts.length + pendingTaskCount,
    blocked_access: posts.filter(p => p.status === 'error').length,
  };

  const reports = runs
    .filter(r => ['done', 'posted', 'pending_approval', 'approved'].includes(r.status))
    .map(r => ({
      id: r.id,
      date: r.created_at,
      status: r.status === 'pending_approval' ? 'needs_approval' : 'complete',
      source: 'supabase',
      label: `Run ${r.week_of || r.id?.slice(0, 8) || '?'}`,
    }));

  const faults = runs
    .filter(r => r.status === 'error')
    .slice(0, 3)
    .map(r => `Run ${r.id?.slice(0, 8) || '?'} failed`);

  const nowMs = Date.now();
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const reportsLast7 = reports.filter(r => new Date(r.date).getTime() > sevenDaysAgoMs).length;

  return {
    state: latest?.status || 'idle',
    reports,
    faults,
    activeWorkflow: {
      name: 'SEO Automation',
      phase: latest?.status || 'idle',
      reportsGenerated: reportsLast7,
    },
    statusCounts,
    workflowStatus: {
      actions: { actions: [], summary: actionSummary },
    },
    runHealth: null,
    source: 'supabase',
  };
}

export function useSeoWorkflow() {
  const [seoWorkflow, setSeoWorkflow] = useState({
    state: 'loading', reports: [], faults: [], activeWorkflow: null, statusCounts: {}, error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await querySeoWorkflow();
        if (!cancelled) setSeoWorkflow({ ...next, error: null });
      } catch {
        if (cancelled) return;
        try {
          const next = await fetchSeoFromSupabase();
          if (!cancelled) setSeoWorkflow(next);
        } catch (err) {
          if (!cancelled) setSeoWorkflow(s => ({ ...s, state: 'offline', error: err.message }));
        }
      }
    }
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return seoWorkflow;
}
