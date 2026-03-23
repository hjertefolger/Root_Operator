import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function ActivityDots() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setActive((p) => (p + 1) % 4), 260);
    return () => clearInterval(t);
  }, []);

  const dotStyle = (idx) => ({
    width: 4,
    height: 4,
    borderRadius: '50%',
    background: '#4B5AFF',
    opacity: active === idx ? 1 : 0.16,
    transform: active === idx ? 'scale(1)' : 'scale(0.78)',
    transition: 'opacity 0.24s ease, transform 0.24s ease',
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '4px 4px', gap: 4 }}>
      <div style={dotStyle(0)} />
      <div style={dotStyle(1)} />
      <div style={dotStyle(3)} />
      <div style={dotStyle(2)} />
    </div>
  );
}

function ActivityTimeline({ activities, waiting }) {
  const items = activities.length > 0 ? activities : waiting ? [{
    id: 'waiting',
    label: 'Waiting for Claude',
    detail: 'Claude has not emitted an activity update yet.',
    active: true,
    done: false,
  }] : [];

  if (items.length === 0) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4 }}>
      {items.map((item) => (
        <div
          key={item.id}
          title={item.detail || item.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 18,
          }}
        >
          {item.active ? (
            <ActivityDots />
          ) : (
            <Check
              size={13}
              strokeWidth={2.4}
              style={{ color: '#4B5AFF', flexShrink: 0 }}
            />
          )}
          <span
            style={{
              fontSize: 13,
              lineHeight: 1.2,
              color: item.active ? '#4B5AFF' : 'rgba(255,255,255,0.4)',
              transition: 'color 0.2s ease',
            }}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

const remarkPlugins = [remarkGfm];

const MONO = "'SF Mono','Menlo','Consolas','Liberation Mono',monospace";

const mdComponents = {
  p: ({ children }) => (
    <p style={{ marginTop: 0, marginBottom: '0.75em', lineHeight: 1.45, wordBreak: 'break-word' }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'rgba(255,255,255,0.95)' }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em>{children}</em>
  ),
  code: ({ inline, children }) => {
    if (inline) {
      return (
        <code style={{
          backgroundColor: 'rgba(255,255,255,0.1)',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: MONO,
          border: '1px solid rgba(255,255,255,0.08)',
          wordBreak: 'break-word',
        }}>{children}</code>
      );
    }
    return (
      <code style={{
        display: 'block',
        fontSize: 13,
        fontFamily: MONO,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'rgba(255,255,255,0.88)',
      }}>{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre style={{
      backgroundColor: 'rgba(0,0,0,0.4)',
      padding: '12px 14px',
      borderRadius: 8,
      marginTop: '0.5em',
      marginBottom: '0.75em',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>{children}</pre>
  ),
  ul: ({ children }) => (
    <ul style={{ marginTop: '0.5em', marginBottom: '0.75em', paddingLeft: '1.5em', lineHeight: 1.45, listStyleType: 'disc' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ marginTop: '0.5em', marginBottom: '0.75em', paddingLeft: '1.5em', lineHeight: 1.45 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ marginTop: '0.25em', marginBottom: '0.25em' }}>{children}</li>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#8b9aff', textDecoration: 'underline' }}>{children}</a>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: '3px solid rgba(255,255,255,0.25)',
      paddingLeft: '1em',
      marginTop: '0.5em',
      marginBottom: '0.75em',
      marginLeft: 0,
      marginRight: 0,
      color: 'rgba(255,255,255,0.7)',
      fontStyle: 'italic',
    }}>{children}</blockquote>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: '1em', marginBottom: '1em' }} />
  ),
  h1: ({ children }) => (
    <p style={{ fontSize: '1.35em', lineHeight: 1.3, fontWeight: 700, marginTop: '1em', marginBottom: '0.5em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h2: ({ children }) => (
    <p style={{ fontSize: '1.2em', lineHeight: 1.3, fontWeight: 600, marginTop: '1em', marginBottom: '0.4em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h3: ({ children }) => (
    <p style={{ fontSize: '1.1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.8em', marginBottom: '0.3em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h4: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h5: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h6: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginTop: '0.5em', marginBottom: '0.75em' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ backgroundColor: 'rgba(255,255,255,0.08)', fontWeight: 600, textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.95)', whiteSpace: 'nowrap' }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}>{children}</td>
  ),
};

const MessageMarkdown = memo(function MessageMarkdown({ content }) {
  return (
    <div className="msg-md" style={{ fontSize: 15, lineHeight: 1.45, wordBreak: 'break-word' }}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={mdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

const ChatMessages = memo(function ChatMessages({ messages, activities, waiting, messagesEndRef }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      {messages.length === 0 && !waiting && activities.length === 0 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <pre style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 7, lineHeight: 1.12, color: 'rgba(75,90,255,0.42)', userSelect: 'none', whiteSpace: 'pre' }}>{`
 ██████╗  ██████╗  ██████╗ ████████╗
 ██╔══██╗██╔═══██╗██╔═══██╗╚══██╔══╝
 ██████╔╝██║   ██║██║   ██║   ██║
 ██╔══██╗██║   ██║██║   ██║   ██║
 ██║  ██║╚██████╔╝╚██████╔╝   ██║
 ╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝

██████╗ ██████╗ ███████╗██████╗  █████╗ ████████╗ ██████╗ ██████╗
██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
██║   ██║██████╔╝█████╗  ██████╔╝███████║   ██║   ██║   ██║██████╔╝
██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗██╔══██║   ██║   ██║   ██║██╔══██╗
╚██████╔╝██║     ███████╗██║  ██║██║  ██║   ██║   ╚██████╔╝██║  ██║
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝`.trimEnd()}</pre>
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
            {msg.role === 'user' ? (
              <p style={{ fontSize: 15, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{msg.content}</p>
            ) : (
              <MessageMarkdown content={msg.content} />
            )}
          </div>
        </div>
      ))}

      {(waiting || activities.length > 0) && (
        <ActivityTimeline activities={activities} waiting={waiting} />
      )}

      <div ref={messagesEndRef} />
    </div>
  );
});

const ChatComposer = memo(function ChatComposer({ canSend, onSend }) {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = Math.min(ta.scrollHeight, 144) + 'px';
  }, [input]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSend || isSending) return;

    setIsSending(true);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = '0px';

    try {
      await onSend(text);
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [input, canSend, isSending, onSend]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const hasContent = input.trim().length > 0;

  return (
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
          disabled={!hasContent || isSending || !canSend}
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
  );
});

function ChannelChat({ socket, encryptInput, e2eReady, messages, setMessages, activities, setActivities, waiting, setWaiting }) {
  const messagesEndRef = useRef(null);
  const prevLengthRef = useRef(messages.length);

  // Scroll when messages change — instant if bulk load, smooth if single new message
  useEffect(() => {
    const isBulkLoad = Math.abs(messages.length - prevLengthRef.current) > 1;
    prevLengthRef.current = messages.length;
    messagesEndRef.current?.scrollIntoView({ behavior: isBulkLoad ? 'instant' : 'smooth' });
  }, [messages, waiting, activities]);
  
  const sendMessage = useCallback(async (text) => {
    if (!text || !socket || !e2eReady) return;

    setActivities([]);

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
  }, [socket, e2eReady, encryptInput, setActivities, setMessages, setWaiting]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#000' }}>
      <ChatMessages
        messages={messages}
        activities={activities}
        waiting={waiting}
        messagesEndRef={messagesEndRef}
      />
      <ChatComposer
        canSend={Boolean(socket && e2eReady)}
        onSend={sendMessage}
      />
    </div>
  );
}

export default ChannelChat;
