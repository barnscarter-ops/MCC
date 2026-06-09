import { useEffect, useState } from 'react';
import { FALLBACK } from '../config/metrics.js';
import { queryAllMetrics, queryModelStatus, queryOrchestratorStatus, querySeoWorkflow } from '../lib/api.js';

export function useMetrics() {
  const [metrics, setMetrics] = useState(FALLBACK);
  const [status, setStatus] = useState({ state: 'loading', updatedAt: null, error: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const entries = await queryAllMetrics();
        if (cancelled) return;
        const next = { ...FALLBACK };
        for (const [key, value] of entries) next[key] = value;
        setMetrics(next);
        setStatus({ state: 'online', updatedAt: new Date(), error: null });
      } catch (error) {
        if (!cancelled) setStatus({ state: 'error', updatedAt: new Date(), error: error.message });
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { metrics, status };
}

export function useModelStatus() {
  const [modelStatus, setModelStatus] = useState({
    state: 'loading',
    model: null,
    contextTokens: null,
    parameterCount: null,
    error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await queryModelStatus();
        if (!cancelled) setModelStatus({ ...next, error: null });
      } catch (error) {
        if (!cancelled) {
          setModelStatus((current) => ({ ...current, state: 'offline', error: error.message }));
        }
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return modelStatus;
}

export function useOrchestratorStatus() {
  const [orchestratorStatus, setOrchestratorStatus] = useState({
    workers: [],
    runs: [],
    updatedAt: null,
    error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await queryOrchestratorStatus();
        if (!cancelled) setOrchestratorStatus({ ...next, error: null });
      } catch (error) {
        if (!cancelled) {
          setOrchestratorStatus((current) => ({ ...current, error: error.message }));
        }
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return orchestratorStatus;
}

export function useSeoWorkflow() {
  const [seoWorkflow, setSeoWorkflow] = useState({
    state: 'loading',
    reports: [],
    faults: [],
    activeWorkflow: null,
    statusCounts: {},
    error: null
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await querySeoWorkflow();
        if (!cancelled) setSeoWorkflow({ ...next, error: null });
      } catch (error) {
        if (!cancelled) {
          setSeoWorkflow((current) => ({ ...current, state: 'error', error: error.message }));
        }
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return seoWorkflow;
}
