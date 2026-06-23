import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMetrics, useModelStatus, useOrchestratorStatus } from './hooks/useMetrics.js';
import { api } from './lib/api.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, readFileText, WORKFLOW_MODES } from './lib/dashboardHelpers.js';
import { Sidebar, DashboardViewContext } from './components/Dashboard.jsx';
import {
  Workstation,
  ModelOps,
  Network,
  Server,
  NetworkMapPage
} from './pages/SystemPages.jsx';
import { OrchestratorPage, EstimateConfirmBar } from './pages/OrchestratorPage.jsx';
import { HomePage } from './pages/HomePage.jsx';
import SEOApprovalPage from './SEOApprovalPage.jsx';
import { isDocumentResponse, MavMarkdown } from './mavUtils.js';
import './styles.css';

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
  const [previewContent, setPreviewContent] = useState(null);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const barFileInputRef = useRef(null);
  const [pendingEstimate, setPendingEstimate] = useState(null);


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

    let accum = '';
    if (workflowMode === 'build') {
      pushChat(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: '⟳ Claude director is planning — this takes 10–20s...' };
        return next;
      });
    } else if (workflowMode === 'ops') {
      pushChat(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: '⟳ Maverick OPS is working on it...' };
        return next;
      });
    }

    try {
      const response = await fetch(api('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: userMsg,
          mode: workflowMode,
          history: chatHistory,
          attachments: attachedFiles,
          ...(pendingEstimate && workflowMode === 'ask' ? { pendingItems: pendingEstimate.items, pendingCustomer: pendingEstimate.customer } : {}),
        }),
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
      // Detect and strip [ESTIMATE_READY] block; set pendingEstimate state
      const estMatch = accum.match(/\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/);
      if (estMatch) {
        try {
          setPendingEstimate(JSON.parse(estMatch[1]));
          accum = accum.replace(/\s*\[ESTIMATE_READY\][\s\S]*?\[\/ESTIMATE_READY\]/, '').trimEnd();
          pushChat(prev => {
            const next = [...prev];
            next[next.length - 1] = { role: 'assistant', content: accum };
            return next;
          });
        } catch {}
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

  async function handleBuildEstimate() {
    if (!pendingEstimate?.items?.length || chatBusy) return;
    const { items, customer = {} } = pendingEstimate;
    setPendingEstimate(null);
    setChatBusy(true);
    setChatPanelOpen(true);
    pushChat(prev => [...prev, { role: 'user', content: '⚡ Build estimate' }, { role: 'assistant', content: '' }]);
    const controller = new AbortController();
    chatAbortRef.current = controller;
    let accum = '';
    try {
      const response = await fetch(api('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Build estimate', mode: 'estimate-ready', lineItems: items, pendingCustomer: customer }),
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
              onClear: () => { pushChat([]); setPreviewContent(null); setAttachedFiles([]); },
              onRestoreJob: (savedHistory) => { pushChat(savedHistory); setPreviewContent(null); setAttachedFiles([]); },
              workflowMode,
              setWorkflowMode,
              attachedFiles,
              onAddFiles: (items) => setAttachedFiles(prev => [...prev, ...items]),
              onRemoveFile: (i) => setAttachedFiles(prev => prev.filter((_, idx) => idx !== i)),
              pendingEstimate,
              onBuildEstimate: handleBuildEstimate,
              onClearPendingEstimate: () => setPendingEstimate(null),
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
          {pendingEstimate && (
            <EstimateConfirmBar
              estimate={pendingEstimate}
              onBuild={handleBuildEstimate}
              onClear={() => setPendingEstimate(null)}
              busy={chatBusy}
            />
          )}
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
              <button type="button" className="clearChatBtn" onClick={() => { pushChat([]); setPreviewContent(null); setAttachedFiles([]); }}>CLR</button>
            )}
          </form>
        </div>}
      </main>
      </div>{/* /appShell */}
    </DashboardViewContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
