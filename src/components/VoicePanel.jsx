import { useEffect, useRef, useState } from 'react';

const WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2';
const RAG_ENDPOINT = '/api/rag-voice-query';
const TOKEN_ENDPOINT = '/api/realtime-token';

export function VoicePanel({ onClose, apiBase = '' }) {
  const [status, setStatus] = useState('connecting');
  const [transcript, setTranscript] = useState([]);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackTimeRef = useRef(0);
  const pendingCallsRef = useRef({});

  useEffect(() => {
    let alive = true;
    async function init() {
      try {
        const resp = await fetch(`${apiBase}${TOKEN_ENDPOINT}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const { token } = await resp.json();
        if (!token || !alive) { setStatus('error'); return; }

        // Browser WebSockets can't set custom headers — use subprotocol auth instead
        const ws = new WebSocket(WS_URL, [
          'realtime',
          `openai-insecure-api-key.${token}`,
          'openai-realtime-v1',
        ]);
        wsRef.current = ws;

        ws.onopen = () => { if (alive) setStatus('ready'); };

        ws.onmessage = async (ev) => {
          if (!alive) return;
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }

          if (msg.type === 'input_audio_buffer.speech_started') setStatus('listening');
          if (msg.type === 'input_audio_buffer.speech_stopped') setStatus('speaking');
          if (msg.type === 'response.done') setStatus('ready');
          if (msg.type === 'error') { console.error('Realtime error:', msg.error); setStatus('error'); }

          if (msg.type === 'response.audio_transcript.delta') {
            setTranscript(prev => {
              const next = [...prev];
              if (!next.length || next[next.length - 1].role !== 'assistant') {
                next.push({ role: 'assistant', text: '' });
              }
              next[next.length - 1] = { ...next[next.length - 1], text: next[next.length - 1].text + msg.delta };
              return next;
            });
          }
          if (msg.type === 'conversation.item.input_audio_transcription.completed') {
            setTranscript(prev => [...prev, { role: 'user', text: msg.transcript }]);
          }

          if (msg.type === 'response.audio.delta' && msg.delta) {
            const ac = audioCtxRef.current;
            if (!ac) return;
            try {
              const binary = atob(msg.delta);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const int16 = new Int16Array(bytes.buffer);
              const float32 = new Float32Array(int16.length);
              for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
              const buf = ac.createBuffer(1, float32.length, 24000);
              buf.getChannelData(0).set(float32);
              const src = ac.createBufferSource();
              src.buffer = buf;
              src.connect(ac.destination);
              const now = ac.currentTime;
              if (playbackTimeRef.current < now) playbackTimeRef.current = now;
              src.start(playbackTimeRef.current);
              playbackTimeRef.current += buf.duration;
            } catch {}
          }

          if (msg.type === 'response.function_call_arguments.delta' && msg.call_id) {
            if (!pendingCallsRef.current[msg.call_id]) {
              pendingCallsRef.current[msg.call_id] = { name: msg.name || '', args: '' };
            }
            pendingCallsRef.current[msg.call_id].args += msg.delta;
            if (msg.name) pendingCallsRef.current[msg.call_id].name = msg.name;
          }
          if (msg.type === 'response.function_call_arguments.done' && msg.call_id) {
            const call = pendingCallsRef.current[msg.call_id] || {};
            try {
              const args = JSON.parse(msg.arguments || call.args || '{}');
              const ragResp = await fetch(`${apiBase}${RAG_ENDPOINT}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: args.query || '' }),
              });
              const ragData = await ragResp.json();
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: JSON.stringify({ answer: ragData.answer }),
                },
              }));
              ws.send(JSON.stringify({ type: 'response.create' }));
            } catch (e) {
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify({ error: e.message }) },
              }));
              ws.send(JSON.stringify({ type: 'response.create' }));
            }
            delete pendingCallsRef.current[msg.call_id];
          }
        };

        ws.onerror = () => setStatus('error');
        ws.onclose = () => { if (alive) setStatus('error'); };

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
        micStreamRef.current = stream;

        const ac = new AudioContext({ sampleRate: 24000 });
        audioCtxRef.current = ac;

        const micSource = ac.createMediaStreamSource(stream);
        // ponytail: ScriptProcessor deprecated but has widest browser support including mobile Safari
        const processor = ac.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
          }
          const bytes = new Uint8Array(int16.buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          wsRef.current.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) }));
        };
        micSource.connect(processor);
        processor.connect(ac.destination);

      } catch (e) {
        console.error('VoicePanel init error:', e);
        if (alive) setStatus('error');
      }
    }
    init();
    return () => {
      alive = false;
      wsRef.current?.close();
      processorRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close();
    };
  }, []);

  const statusLabel = {
    connecting: 'Connecting…',
    ready: 'Listening…',
    listening: '🎙 Hearing you…',
    speaking: '◈ Maverick speaking…',
    error: 'Connection error — close and retry',
  }[status] || '';

  return (
    <div className="voicePanel">
      <div className="voicePanelHeader">
        <span className="voicePanelStatus" data-status={status}>{statusLabel}</span>
        <button className="voicePanelClose" onClick={onClose} type="button">✕ END CALL</button>
      </div>
      <div className="voiceTranscript">
        {transcript.map((t, i) => (
          <div key={i} className={`voiceLine ${t.role}`}>
            <span className="voiceRole">{t.role === 'user' ? 'YOU' : 'MAV'}</span>
            <span className="voiceText">{t.text}</span>
          </div>
        ))}
        {transcript.length === 0 && (
          <div className="voiceHint">Start speaking — Maverick is listening.</div>
        )}
      </div>
    </div>
  );
}
