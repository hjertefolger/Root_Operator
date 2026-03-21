import { useState, useRef, useEffect, useCallback } from 'react';

// 4 dots in 2x2 grid, one lit at a time rotating clockwise
function ThinkingIndicator() {
  const [active, setActive] = useState(0);
  // Order: top-left(0) → top-right(1) → bottom-right(2) → bottom-left(3)
  useEffect(() => {
    const t = setInterval(() => setActive(p => (p + 1) % 4), 300);
    return () => clearInterval(t);
  }, []);

  const dot = (idx) => ({
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: '#4B5AFF',
    opacity: active === idx ? 0.9 : 0.15,
    transition: 'opacity 0.2s',
  });

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', paddingLeft: 4 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '5px 5px', gap: 4, padding: 8 }}>
        <div style={dot(0)} />
        <div style={dot(1)} />
        <div style={dot(3)} />
        <div style={dot(2)} />
      </div>
    </div>
  );
}

function ChannelChat({ socket, encryptInput, decryptOutput, e2eReady }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = Math.min(ta.scrollHeight, 144) + 'px';
  }, [input]);

  useEffect(() => {
    if (!socket || !e2eReady) return;
    const handleMessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext === null) return;
        let parsed;
        try { parsed = JSON.parse(plaintext); } catch { return; }
        if (parsed.type === 'channel_history') {
          // Full history from server on reconnect
          setMessages(parsed.messages || []);
          setWaiting(false);
        } else if (parsed.type === 'channel_message') {
          setWaiting(false);
          setMessages(prev => [...prev, {
            role: parsed.role || 'assistant',
            content: parsed.content,
            ts: parsed.ts || new Date().toISOString(),
          }]);
        }
      }
    };
    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, e2eReady, decryptOutput]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, waiting]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !socket || !e2eReady || isSending) return;
    setIsSending(true);
    setInput('');
    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      ts: new Date().toISOString(),
    }]);
    const encrypted = await encryptInput(text);
    if (encrypted) {
      socket.send(JSON.stringify({ type: 'e2e_input', ...encrypted }));
    }
    setWaiting(true);
    setIsSending(false);
    textareaRef.current?.focus();
  }, [input, socket, e2eReady, encryptInput, isSending]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const hasContent = input.trim().length > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#000' }}>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        {messages.length === 0 && !waiting && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, fontWeight: 400, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.2)' }}>
              ROOT_OPERATOR
            </span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '85%',
              borderRadius: 18,
              padding: '10px 14px',
              background: msg.role === 'user' ? '#4B5AFF' : 'rgba(255,255,255,0.08)',
              color: msg.role === 'user' ? '#fff' : 'rgba(255,255,255,0.9)',
            }}>
              <p style={{ fontSize: 15, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{msg.content}</p>
            </div>
          </div>
        ))}

        {waiting && <ThinkingIndicator />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div style={{
        flexShrink: 0,
        padding: '6px 16px',
        paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
        maxWidth: 640,
        width: '100%',
        alignSelf: 'center',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 24,
          padding: '8px 8px 8px 16px',
        }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message"
            rows={1}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              color: '#fff',
              fontSize: 15,
              lineHeight: '22px',
              padding: '5px 0',
              minHeight: 34,
              maxHeight: 144,
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!hasContent || isSending}
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              borderRadius: '50%',
              border: 'none',
              background: hasContent ? '#4B5AFF' : 'rgba(255,255,255,0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: hasContent ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="14" x2="8" y2="3" />
              <polyline points="3,7 8,2 13,7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChannelChat;
