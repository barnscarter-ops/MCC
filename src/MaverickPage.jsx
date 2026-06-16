import React, { useEffect, useRef, useState } from 'react';

const API_BASE = '';

function MsgBubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`mavMsg ${isUser ? 'mavMsg--user' : 'mavMsg--assistant'}`}>
      <div className="mavMsg__bubble">
        {msg.content.split('\n').map((line, i) => (
          <React.Fragment key={i}>
            {line}
            {i < msg.content.split('\n').length - 1 && <br />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function SourceChip({ source }) {
  const label = typeof source === 'string'
    ? source
    : source?.title || source?.source || source?.id || source?.url || source?.type || 'source';
  const type = typeof source === 'object' && source?.type ? `${source.type}: ` : '';
  const score = typeof source === 'object' && Number.isFinite(source?.score) ? ` (${source.score.toFixed(3)})` : '';
  const title = typeof source === 'object'
    ? source.text || source.source || source.title || label
    : source;

  return (
    <span className="mavSource" title={title}>
      {type}{label}{score}
    </span>
  );
}

export default function MaverickPage() {
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastSources, setLastSources] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    fetch(`/api/rag/stats`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    const newHistory = [...history, { role: 'user', content: msg }];
    setHistory(newHistory);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          history: history,
          top_k: 12,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }

      const data = await res.json();
      setHistory([...newHistory, { role: 'assistant', content: data.reply }]);
      setLastSources(data.sources || []);
    } catch (e) {
      setError(e.message);
      setHistory([...newHistory, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearChat = () => {
    setHistory([]);
    setLastSources([]);
    setError(null);
  };

  return (
    <div className="mavPage">
      <div className="mavHeader">
        <div className="mavHeaderLeft">
          <h2 className="mavTitle">Ask Maverick</h2>
          <span className="mavSubtitle">Estimating &amp; Proposal Agent — Grizzly Electrical Solutions</span>
        </div>
        <div className="mavHeaderRight">
          {stats && (
            <div className="mavStats">
              <span className="mavStatChip">{stats.grizzly_hcp ?? 0} customer records</span>
              <span className="mavStatChip">{stats.reference_docs ?? 0} reference chunks</span>
            </div>
          )}
          <button className="mavClearBtn" onClick={clearChat} title="Clear conversation">
            New Chat
          </button>
        </div>
      </div>

      <div className="mavChat">
        {history.length === 0 && (
          <div className="mavEmpty">
            <p>Tell Maverick about a job scope, customer, or ask for a proposal.</p>
            <div className="mavPrompts">
              {[
                'Start an estimate for a 200A service upgrade residential',
                'Look up customer Grizzly demo and check last job',
                'Write a Good/Better/Best proposal for panel replacement',
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
          <MsgBubble key={i} msg={msg} />
        ))}

        {loading && (
          <div className="mavMsg mavMsg--assistant">
            <div className="mavMsg__bubble mavMsg__bubble--loading">
              <span className="mavDot" /><span className="mavDot" /><span className="mavDot" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {lastSources.length > 0 && (
        <div className="mavSources">
          <span className="mavSourcesLabel">Sources:</span>
          {lastSources.slice(0, 6).map((s, i) => (
            <SourceChip key={i} source={s} />
          ))}
        </div>
      )}

      <div className="mavInputRow">
        <textarea
          ref={textareaRef}
          className="mavTextarea"
          rows={3}
          placeholder="Describe the job scope, ask about a customer, or request a proposal…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading}
        />
        <button
          className={`mavSendBtn ${loading ? 'mavSendBtn--loading' : ''}`}
          onClick={send}
          disabled={loading || !input.trim()}
        >
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
