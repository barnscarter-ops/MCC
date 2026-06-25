import React, { useEffect, useRef, useState } from 'react';
import { VoicePanel } from './components/VoicePanel.jsx';

function MsgBubble({ msg, busy, isLast }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`mavMsg ${isUser ? 'mavMsg--user' : 'mavMsg--assistant'}`}>
      <div className="mavMsg__bubble">
        {msg.content
          ? msg.content.split('\n').map((line, i, arr) => (
              <React.Fragment key={i}>
                {line}
                {i < arr.length - 1 && <br />}
              </React.Fragment>
            ))
          : (busy && isLast ? <span className="mavDot mavDot--cursor">▋</span> : null)}
      </div>
    </div>
  );
}

export default function MaverickPage() {
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingEstimate, setPendingEstimate] = useState(null);
  const [showVoice, setShowVoice] = useState(false);
  const [error, setError] = useState(null);

  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, busy]);

  function pushHistory(updater) {
    setHistory(prev => typeof updater === 'function' ? updater(prev) : updater);
  }

  async function _submit(text) {
    if (!text.trim() || busy) return;
    setError(null);
    setBusy(true);

    const userMsg = { role: 'user', content: text };
    pushHistory(prev => [...prev, userMsg, { role: 'assistant', content: '' }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let accum = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, mode: 'agent', history }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`API ${res.status}`);

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
          if (!raw || raw === '[DONE]') continue;
          try {
            const tok = JSON.parse(raw);
            const delta = tok.choices?.[0]?.delta?.content || '';
            if (delta) {
              accum += delta;
              pushHistory(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: accum };
                return next;
              });
            }
          } catch {}
        }
      }

      // Detect [ESTIMATE_READY] block
      const estMatch = accum.match(/\[ESTIMATE_READY\]([\s\S]*?)\[\/ESTIMATE_READY\]/);
      if (estMatch) {
        try {
          setPendingEstimate(JSON.parse(estMatch[1]));
          accum = accum.replace(/\s*\[ESTIMATE_READY\][\s\S]*?\[\/ESTIMATE_READY\]/, '').trimEnd();
          pushHistory(prev => {
            const next = [...prev];
            next[next.length - 1] = { role: 'assistant', content: accum };
            return next;
          });
        } catch {}
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        pushHistory(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: `[Error: ${err.message}]` };
          return next;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    await _submit(text);
  }

  function submitMessage(text) {
    const trimmed = text?.trim();
    if (!trimmed || busy) return;
    _submit(trimmed);
  }

  async function handleBuildEstimate() {
    if (!pendingEstimate || busy) return;
    const est = pendingEstimate;
    setPendingEstimate(null);
    setBusy(true);
    pushHistory(prev => [...prev, { role: 'user', content: '⚡ Build estimate' }, { role: 'assistant', content: '' }]);
    const controller = new AbortController();
    abortRef.current = controller;
    let accum = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Build estimate',
          mode: 'estimate-ready',
          lineItems: est.lineItems || [],
          newPricebookItems: est.newPricebookItems?.length ? est.newPricebookItems : undefined,
          pendingCustomer: est.customerName ? { name: est.customerName, email: est.customerEmail, phone: est.customerPhone } : undefined,
          techIds: est.techIds?.length ? est.techIds : undefined,
          depositPercent: est.depositPercent ?? undefined,
        }),
        signal: controller.signal,
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
          if (!raw || raw === '[DONE]') continue;
          try {
            const tok = JSON.parse(raw);
            const delta = tok.choices?.[0]?.delta?.content || '';
            if (delta) {
              accum += delta;
              pushHistory(prev => {
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
        setError(err.message);
        pushHistory(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: `[Error: ${err.message}]` };
          return next;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const lastAssistantText = [...history].reverse().find(m => m.role === 'assistant')?.content || '';

  return (
    <div className="mavPage">
      <div className="mavHeader">
        <div className="mavHeaderLeft">
          <h2 className="mavTitle">Ask Maverick</h2>
          <span className="mavSubtitle">Estimating &amp; Proposal Agent — Grizzly Electrical Solutions</span>
        </div>
        <div className="mavHeaderRight">
          <button
            className={`mavVoiceBtn${showVoice ? ' active' : ''}`}
            onClick={() => setShowVoice(v => !v)}
            disabled={busy && !showVoice}
            title="Voice session"
            type="button"
          >🎙 VOICE</button>
          {history.length > 0 && !busy && (
            <button className="mavClearBtn" onClick={() => { setHistory([]); setPendingEstimate(null); setError(null); }} title="Clear conversation">
              New Chat
            </button>
          )}
        </div>
      </div>

      <div className="mavChat">
        {history.length === 0 && !showVoice && (
          <div className="mavEmpty">
            <p>Tell Maverick about a job scope, customer, or ask for a proposal.</p>
            <div className="mavPrompts">
              {[
                'Start an estimate for a 200A service upgrade residential',
                'Look up customer Grizzly demo and check last job',
                'Create an HCP estimate for a panel replacement',
                'What does the Oncor spec require for underground service?',
              ].map(p => (
                <button key={p} className="mavPromptChip" onClick={() => { setInput(p); textareaRef.current?.focus(); }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((msg, i) => (
          <MsgBubble key={i} msg={msg} busy={busy} isLast={i === history.length - 1} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="mavControls">
        {/* Estimate confirm bar */}
        {pendingEstimate && (
          <div className="estimateConfirmBar">
            <span className="estimateConfirmInfo">
              📋 <strong>{(pendingEstimate.lineItems?.length || 0) + (pendingEstimate.newPricebookItems?.length || 0)} items</strong> ready
              {pendingEstimate.customerName ? ` — ${pendingEstimate.customerName}` : ''}
            </span>
            <div className="estimateConfirmActions">
              <button className="estimateConfirmClear" onClick={() => setPendingEstimate(null)} type="button">✕</button>
              <button className="estimateConfirmBuild" onClick={handleBuildEstimate} disabled={busy} type="button">
                {busy ? 'Working…' : '⚡ BUILD IT'}
              </button>
            </div>
          </div>
        )}

        {/* Voice panel */}
        {showVoice && (
          <VoicePanel
            onClose={() => setShowVoice(false)}
            onSubmitText={submitMessage}
            onStop={() => abortRef.current?.abort()}
            onBuildEstimate={handleBuildEstimate}
            pendingEstimate={pendingEstimate}
            busy={busy}
            lastAssistantText={lastAssistantText}
          />
        )}

        {/* Text input */}
        <form className="mavInputRow" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            className="mavTextarea"
            rows={3}
            placeholder={busy ? 'Maverick is responding…' : 'Describe the job scope, ask about a customer, or request a proposal…'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
            disabled={busy}
          />
          <div className="mavInputActions">
            {busy
              ? <button type="button" className="mavStopBtn" onClick={() => abortRef.current?.abort()}>[ STOP ]</button>
              : <button type="submit" className="mavSendBtn" disabled={!input.trim()}>Send</button>
            }
          </div>
        </form>

        {error && <div className="mavError">{error}</div>}
      </div>
    </div>
  );
}
