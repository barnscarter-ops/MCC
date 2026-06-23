// Orchestrator page + its chat/build UI cluster (chat session, job history, staged-apply
// button, folder picker, build chat), extracted from main.jsx. OrchestratorPage is the
// only export App renders; the rest are internal collaborators.
import React, { useEffect, useRef, useState } from 'react';
import { Panel } from '../components/Dashboard.jsx';
import { MavMarkdown } from '../mavUtils.js';
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  WORKFLOW_MODES,
  workerLabel,
  readFileText,
  mccLoadJob,
  mccLoadJobIndex,
  mccSaveJob
} from '../lib/dashboardHelpers.js';
import {
  api,
  createLocalWorkerBrief,
  createOrchestratorPlan,
  queryMemory,
} from '../lib/api.js';
import { useOrchestratorStatus } from '../hooks/useMetrics.js';

export function ApplyStagedButton({ stageId }) {
  const [state, setState] = useState('idle');
  const [detail, setDetail] = useState('');

  async function apply() {
    setState('busy');
    try {
      const res = await fetch(api('/api/build/apply'), {
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

export function MccJobHistoryPanel({ onRestore, onClose }) {
  const jobs = mccLoadJobIndex();
  return (
    <div className="jobPanel">
      <div className="jobPanelHeader">
        <span>SAVED JOBS</span>
        <button className="jobPanelClose" onClick={onClose}>×</button>
      </div>
      {jobs.length === 0
        ? <div className="jobPanelEmpty">No saved jobs yet. CLR to save the current conversation.</div>
        : <div className="jobPanelList">
            {jobs.map(j => (
              <button key={j.id} className="jobPanelItem" onClick={() => { onRestore(mccLoadJob(j.id)); onClose(); }}>
                <span className="jobPanelLabel">{j.label}</span>
                <span className="jobPanelTs">{new Date(j.ts).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
      }
    </div>
  );
}

export function EstimateConfirmBar({ estimate, onBuild, onClear, busy }) {
  const items = estimate?.items || [];
  const customer = estimate?.customer;
  return (
    <div className="estimateConfirmBar">
      <span className="estimateConfirmInfo">
        📋 <strong>{items.length} item{items.length !== 1 ? 's' : ''}</strong> ready to push
        {customer?.name ? ` — ${customer.name}` : ''}
      </span>
      <div className="estimateConfirmActions">
        <button className="estimateConfirmClear" onClick={onClear} disabled={busy} type="button">✕</button>
        <button className="estimateConfirmBuild" onClick={onBuild} disabled={busy} type="button">
          {busy ? 'Creating…' : '⚡ BUILD IT'}
        </button>
      </div>
    </div>
  );
}

export function ChatSessionPanel({ history, busy, input, setInput, onSubmit, onCollapse, onStop, onClear, onRestoreJob, workflowMode, setWorkflowMode, attachedFiles, onAddFiles, onRemoveFile, permanent, pendingEstimate, onBuildEstimate, onClearPendingEstimate }) {
  const historyRef = useRef(null);
  const rafRef = useRef(null);
  const fileInputRef = useRef(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const [showJobHistory, setShowJobHistory] = useState(false);

  function toggleVoice() {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    let silenceTimer = null;
    rec.onresult = e => {
      clearTimeout(silenceTimer);
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
      setInput(transcript);
      silenceTimer = setTimeout(() => rec.stop(), 3000);
    };
    rec.onend = () => { clearTimeout(silenceTimer); setIsListening(false); };
    recognitionRef.current = rec;
    rec.start();
    setIsListening(true);
  }

  function handleClear() {
    const lbl = window.prompt('Save this job as:', 'Job ' + new Date().toLocaleDateString());
    if (lbl !== null) mccSaveJob(lbl.trim() || 'Untitled', history);
    onClear();
  }

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
      if (raw && typeof raw === 'object' && raw.__image) {
        items.push({ name: file.name, type: 'image', data: raw.data, mimeType: raw.mimeType });
      } else {
        const content = (typeof raw === 'string' ? raw : '').slice(0, MAX_FILE_BYTES);
        items.push({ name: file.name, content });
        total += content.length;
      }
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
      <input ref={fileInputRef} type="file" multiple accept="image/*,.js,.jsx,.ts,.tsx,.mjs,.py,.css,.json,.md,.sh,.ps1,.yaml,.yml,.txt,.html" style={{ display: 'none' }} onChange={e => handleFilePick(e)} />
      <div className="chatSessionHistory" ref={historyRef}>
        {history.length === 0 && <div className="chatSessionEmpty">No messages yet. Send a command below.</div>}
        {history.map((msg, i) => {
          const isLast = i === history.length - 1;
          const streaming = busy && isLast;
          const stageMatch = msg.role === 'assistant' && !streaming
            ? msg.content?.match(/\[STAGED:(stage-[\w-]+)\]/)
            : null;
          const isAssistant = msg.role === 'assistant';
          return (
            <div key={i} className={`chatMsg ${msg.role}`} style={{ position: 'relative' }}>
              <span className="chatRole">{isAssistant ? 'MAV' : 'CMD'}</span>
              {isAssistant && msg.content
                ? <div className="chatText"><MavMarkdown content={msg.content} />{streaming && <span className="streamCursor">▋</span>}</div>
                : <span className="chatText">{msg.content || (streaming ? '▋' : '')}</span>
              }
              {stageMatch && <ApplyStagedButton stageId={stageMatch[1]} />}
              {isAssistant && msg.content && !streaming && (
                <button className="copyBtn" title="Copy" onClick={() => navigator.clipboard.writeText(msg.content)}>⧉</button>
              )}
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
            <span key={i} className={`attachChip${f.type === 'folder' ? ' folderChip' : f.type === 'image' ? ' imageChip' : ''}`}>
              {f.type === 'image'
                ? <img className="attachChipThumb" src={`data:${f.mimeType};base64,${f.data}`} alt={f.name} />
                : <span className="attachChipLabel" title={f.path || f.name}>{f.type === 'folder' ? '📁 ' : ''}{f.name.split(/[\\/]/).filter(Boolean).pop() || f.name}{f.type === 'folder' ? '/' : ''}</span>
              }
              <button type="button" className="attachChipRemove" onClick={() => onRemoveFile(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      {pendingEstimate && (
        <EstimateConfirmBar
          estimate={pendingEstimate}
          onBuild={onBuildEstimate}
          onClear={onClearPendingEstimate}
          busy={busy}
        />
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
          <button type="button" className={`micBtn${isListening ? ' active' : ''}`} onClick={toggleVoice} disabled={busy} title="Voice input">
            {isListening ? '⏹' : '🎤'}
          </button>
          <button type="button" className="jobHistoryBtn" onClick={() => setShowJobHistory(v => !v)} title="Saved jobs">📋</button>
          {busy
            ? <button type="button" className="stopBtn" onClick={onStop}>[ STOP ]</button>
            : <button type="submit" className="sendBtn" disabled={!input.trim()}>SEND</button>
          }
          {history.length > 0 && !busy && (
            <button type="button" className="clearChatBtn" onClick={handleClear}>CLR</button>
          )}
        </div>
        {showJobHistory && (
          <MccJobHistoryPanel
            onRestore={onRestoreJob}
            onClose={() => setShowJobHistory(false)}
          />
        )}
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

export function OrchestratorPage({ modelStatus, chatSession }) {
  const orchestratorStatus = useOrchestratorStatus();
  const [idea, setIdea] = useState('Build an app with my standard tech stack that tells me where the closest ice cream shop is when it is 100 degrees outside.');
  const [activeRun, setActiveRun] = useState(null);
  const [workerBrief, setWorkerBrief] = useState(null);
  const [memoryContext, setMemoryContext] = useState({ state: 'loading', memories: [], results: [], typeCounts: {}, warnings: [] });
  const [busy, setBusy] = useState(false);
  const [briefBusyId, setBriefBusyId] = useState(null);
  const [error, setError] = useState(null);
  const run = activeRun || orchestratorStatus.runs?.[0] || null;

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
        pendingEstimate={chatSession.pendingEstimate}
        onBuildEstimate={chatSession.onBuildEstimate}
        onClearPendingEstimate={chatSession.onClearPendingEstimate}
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
          {(memoryContext.results || memoryContext.memories || []).slice(0, 5).map((memory) => (
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
                    {briefBusyId === task.id ? 'Running...' : 'Brief'}
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

      {workerBrief && (
        <Panel title="LOCAL WORKER BRIEF" className="briefPanel">
          <div className="briefTask">{workerBrief.task.title}</div>
          <pre>{workerBrief.brief}</pre>
        </Panel>
      )}

      {(error || orchestratorStatus.error) ? <div className="errorStrip">{error || orchestratorStatus.error}</div> : null}
    </div>
  );
}

export function FolderPickerModal({ onSelect, onClose }) {
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
          <span className="folderPickerTitle">PC DRIVES</span>
          <button className="folderPickerClose" onClick={onClose}>✕</button>
        </div>

        <div className="folderPickerDrives">
          {['C:\\', 'D:\\', 'E:\\'].map(drive => (
            <button
              key={drive}
              className={`folderPickerDriveBtn${currentPath.toUpperCase().startsWith(drive.toUpperCase()) ? ' active' : ''}`}
              onClick={() => loadPath(drive)}
            >
              {drive.replace('\\', ':')} {drive === 'C:\\' ? 'SYSTEM' : drive === 'D:\\' ? 'STORAGE' : 'ARCHIVE'}
            </button>
          ))}
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

export function BuildChatPanel() {
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
  const inputRef = useRef(null);

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
    inputRef.current?.focus();
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
      const res = await fetch(api('/api/build-chat'), {
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
            ref={inputRef}
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
