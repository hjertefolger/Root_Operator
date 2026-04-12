import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from 'react';
import { Check, ArrowUp, ChevronDown, Loader, Plus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const isMobileChatInput = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24;
const loadStoredDraft = (storageKey) => {
  if (!storageKey || typeof window === 'undefined') {
    return '';
  }

  try {
    return sessionStorage.getItem(storageKey) || '';
  } catch (error) {
    console.warn('[CHAT] Failed to restore draft:', error.message);
    return '';
  }
};

function isNearBottom(container) {
  return (container.scrollHeight - container.scrollTop - container.clientHeight) <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

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

function ActivityTimeline({ activities, waiting, assistantName }) {
  const items = activities.length > 0 ? activities : waiting ? [{
    id: 'waiting',
    label: `Waiting for ${assistantName}`,
    detail: `${assistantName} has not emitted an activity update yet.`,
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

function splitFileNameExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toUpperCase() };
}

function parseFileAttachments(content) {
  const lines = content.split('\n');
  const textLines = [];
  const files = [];
  for (const line of lines) {
    const match = line.match(/^📎\s+(.+?)(?:\|(\d+))?$/);
    if (match) {
      files.push({ name: match[1], size: match[2] ? parseInt(match[2], 10) : null });
    } else {
      textLines.push(line);
    }
  }
  return { text: textLines.join('\n').trim(), files };
}

const ChatMessageItem = memo(function ChatMessageItem({ role, content }) {
  const isUser = role === 'user';
  const { text, files } = isUser ? parseFileAttachments(content) : { text: content, files: [] };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4 }}>
      {text && (
        <div style={{
          maxWidth: '85%',
          borderRadius: 18,
          padding: '10px 14px',
          background: isUser ? '#4B5AFF' : 'rgba(255,255,255,0.08)',
          color: isUser ? '#fff' : 'rgba(255,255,255,0.9)',
        }}>
          {isUser ? (
            <p style={{ fontSize: 15, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{text}</p>
          ) : (
            <MessageMarkdown content={text} />
          )}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '85%' }}>
          {files.map((f, i) => {
            const { stem, ext } = splitFileNameExt(f.name);
            return (
              <div key={`file-${i}-${f.name}`} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'transparent',
              }}>
                <Plus size={12} strokeWidth={2.5} style={{ color: '#4B5AFF', flexShrink: 0 }} />
                <span style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.55)',
                  fontFamily: MONO,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 120,
                  minWidth: 0,
                }}>
                  {stem}
                </span>
                {ext && <span style={{ fontSize: 13, color: '#4B5AFF', fontFamily: MONO, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {ext}
                </span>}
                {f.size != null && <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', fontFamily: MONO, flexShrink: 0 }}>
                  {formatFileSize(f.size)}
                </span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const ChatMessages = memo(function ChatMessages({
  messages,
  activities,
  waiting,
  assistantName,
  scrollContainerRef,
  messagesEndRef,
}) {
  return (
    <div
      ref={scrollContainerRef}
      className="channel-chat-scroll"
      style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, maxWidth: 640, width: '100%', alignSelf: 'center' }}
    >
      {messages.length === 0 && !waiting && activities.length === 0 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <pre
              aria-hidden="true"
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 7,
                lineHeight: 1.12,
                color: '#4B5AFF',
                userSelect: 'none',
                whiteSpace: 'pre',
                margin: 0,
                textAlign: 'left',
              }}
            >{`██████╗  ██████╗  ██████╗ ████████╗
██╔══██╗██╔═══██╗██╔═══██╗╚══██╔══╝
██████╔╝██║   ██║██║   ██║   ██║
██╔══██╗██║   ██║██║   ██║   ██║
██║  ██║╚██████╔╝╚██████╔╝   ██║
╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝`}</pre>
            <pre
              aria-hidden="true"
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 7,
                lineHeight: 1.12,
                color: '#4B5AFF',
                userSelect: 'none',
                whiteSpace: 'pre',
                margin: 0,
                textAlign: 'left',
              }}
            >{` ██████╗ ██████╗ ███████╗██████╗  █████╗ ████████╗ ██████╗ ██████╗
██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
██║   ██║██████╔╝█████╗  ██████╔╝███████║   ██║   ██║   ██║██████╔╝
██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗██╔══██║   ██║   ██║   ██║██╔══██╗
╚██████╔╝██║     ███████╗██║  ██║██║  ██║   ██║   ╚██████╔╝██║  ██║
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝`}</pre>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader size={14} strokeWidth={2} className="animate-spin" style={{ color: '#4B5AFF' }} />
            <span style={{ fontSize: 12, color: '#4B5AFF', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
              Loading Conversation
            </span>
          </div>
        </div>
      )}

      {messages.map((msg, i) => {
        const messageKey = msg.ts
          ? `${msg.role}:${msg.ts}`
          : `${msg.role}:${i}:${msg.content}`;

        return (
          <ChatMessageItem
            key={messageKey}
            role={msg.role}
            content={msg.content}
          />
        );
      })}

      {(waiting || activities.length > 0) && (
        <ActivityTimeline activities={activities} waiting={waiting} assistantName={assistantName} />
      )}

      <div ref={messagesEndRef} />
    </div>
  );
});

const ACCEPTED_FILE_TYPES = 'image/*,.pdf,.txt,.md,.csv,.json,.py,.js,.ts,.jsx,.tsx,.html,.css,.svg,.xml,.yaml,.yml,.toml,.env,.log,.sql,.rb,.go,.rs,.swift,.kt,.java,.c,.cpp,.h,.hpp';

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ChatComposer = memo(function ChatComposer({ canSend, onSend, onSendFile, uploadProgress, onAbortUpload, draftStorageKey }) {
  const [input, setInput] = useState(() => loadStoredDraft(draftStorageKey));
  const [isSending, setIsSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!draftStorageKey || typeof window === 'undefined') {
      return;
    }

    try {
      if (input) {
        sessionStorage.setItem(draftStorageKey, input);
      } else {
        sessionStorage.removeItem(draftStorageKey);
      }
    } catch (error) {
      console.warn('[CHAT] Failed to persist draft:', error.message);
    }
  }, [draftStorageKey, input]);

  useEffect(() => {
    if (!draftStorageKey) {
      return;
    }

    setInput(loadStoredDraft(draftStorageKey));
  }, [draftStorageKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = Math.min(ta.scrollHeight, 144) + 'px';
  }, [input]);

  const sendMessage = useCallback(async () => {
    if (isSending) return;

    const text = input.trim();
    const files = [...pendingFiles];

    if (!files.length && !text) return;
    if (!canSend) return;

    setIsSending(true);
    setInput('');
    setPendingFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = '0px';

    try {
      if (files.length && onSendFile) {
        // Send first file with caption, rest without
        await onSendFile(files[0], text);
        for (let i = 1; i < files.length; i++) {
          await onSendFile(files[i], '');
        }
      } else if (text) {
        await onSend(text);
      }
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [input, pendingFiles, canSend, isSending, onSend, onSendFile]);

  const handleKeyDown = useCallback((e) => {
    if (e.key !== 'Enter' || e.nativeEvent?.isComposing) {
      return;
    }

    if (isMobileChatInput) {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        sendMessage();
      }
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      return;
    }

    if (!e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const handleFileChange = useCallback((e) => {
    const files = e.target.files;
    if (files?.length) {
      setPendingFiles(prev => [...prev, ...Array.from(files)]);
      textareaRef.current?.focus();
    }
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, []);

  const removePendingFile = useCallback((index) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const hasContent = input.trim().length > 0 || pendingFiles.length > 0;
  const isUploading = uploadProgress !== null;
  const hasAttachSupport = typeof onSendFile === 'function';

  return (
    <div style={{
      flexShrink: 0,
      padding: '8px 16px',
      paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
      maxWidth: 640,
      width: '100%',
      alignSelf: 'center',
    }}>
      {/* Attachment preview chips */}
      {pendingFiles.length > 0 && !isUploading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {pendingFiles.map((file, i) => {
            const { stem, ext } = splitFileNameExt(file.name);
            return (
              <div key={`${file.name}-${i}`} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 999,
                maxWidth: 'fit-content',
              }}>
                <Plus size={12} strokeWidth={2.5} style={{ color: '#4B5AFF', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120, minWidth: 0 }}>
                  {stem}
                </span>
                {ext && <span style={{ fontSize: 13, color: '#4B5AFF', fontFamily: MONO, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {ext}
                </span>}
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', fontFamily: MONO, flexShrink: 0 }}>
                  {formatFileSize(file.size)}
                </span>
                <button
                  onClick={() => removePendingFile(i)}
                  style={{
                    background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >
                  <X size={11} strokeWidth={2.5} color="rgba(255,255,255,0.3)" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {/* Upload progress */}
      {isUploading && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          marginBottom: 6,
        }}>
          <Loader size={12} strokeWidth={2} className="animate-spin" style={{ color: '#4B5AFF', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', flex: 1 }}>
            Sending {uploadProgress.filename} — {uploadProgress.percent}%
          </span>
          {onAbortUpload && (
            <button
              onClick={onAbortUpload}
              style={{
                background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <X size={12} strokeWidth={2} color="rgba(255,255,255,0.5)" />
            </button>
          )}
        </div>
      )}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
      }}>
        {/* Attach button — outside the pill */}
        {hasAttachSupport && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || isSending}
            style={{
              flexShrink: 0,
              width: 46,
              height: 46,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isUploading || isSending ? 'default' : 'pointer',
              opacity: isUploading || isSending ? 0.4 : 1,
              padding: 0,
              transition: 'background 0.15s',
            }}
          >
            <Plus size={14} strokeWidth={2} color="#fff" />
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          multiple
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        {/* Input pill with inline send */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 24,
          padding: '7px 8px 7px 16px',
          minWidth: 0,
        }}>
          <textarea
            ref={textareaRef}
            className="channel-chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={pendingFiles.length ? 'Add a caption...' : 'Ask me anything'}
            enterKeyHint={isMobileChatInput ? 'enter' : 'send'}
            rows={1}
            disabled={isUploading}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              color: '#fff',
              fontSize: 15,
              lineHeight: '20px',
              padding: '6px 0',
              minHeight: 32,
              maxHeight: 144,
              fontFamily: 'inherit',
              display: 'block',
            }}
          />
          {/* Send button — inside the pill */}
          <button
            onClick={sendMessage}
            disabled={!hasContent || isSending || isUploading || !canSend}
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: '50%',
              border: 'none',
              background: hasContent && !isUploading ? '#4B5AFF' : 'rgba(255,255,255,0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: hasContent && !isUploading ? 'pointer' : 'default',
              transition: 'background 0.15s',
              marginLeft: 8,
            }}
          >
            <ArrowUp size={14} strokeWidth={2} color="#fff" />
          </button>
        </div>
      </div>
    </div>
  );
});

function ChannelChat({
  socket,
  encryptInput,
  e2eReady,
  assistantName = 'Operator',
  messages,
  setMessages,
  activities,
  setActivities,
  waiting,
  setWaiting,
  onSubmitMessage,
  onSendFile,
  uploadProgress = null,
  onAbortUpload,
  canSendOverride,
  draftStorageKey = '',
  forceScrollToBottomKey = 0,
}) {
  const scrollContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const prevLengthRef = useRef(0);
  const prevWaitingRef = useRef(false);
  const prevLatestActivityIdRef = useRef('');
  const hasInitializedScrollRef = useRef(false);
  const userDetachedFromBottomRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const shouldAutoScrollRef = useRef(true);
  const nextScrollBehaviorRef = useRef('auto');
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const canSend = typeof canSendOverride === 'boolean'
    ? canSendOverride
    : Boolean(socket && e2eReady);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }

    const handleScroll = () => {
      const nearBottom = isNearBottom(container);
      const scrolledUp = container.scrollTop < lastScrollTopRef.current;

      setShowScrollToBottom(!nearBottom);

      if (nearBottom) {
        shouldAutoScrollRef.current = true;
        userDetachedFromBottomRef.current = false;
      } else if (scrolledUp) {
        shouldAutoScrollRef.current = false;
        userDetachedFromBottomRef.current = true;
      }

      lastScrollTopRef.current = container.scrollTop;
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    shouldAutoScrollRef.current = true;
    userDetachedFromBottomRef.current = false;
    nextScrollBehaviorRef.current = 'smooth';
    setShowScrollToBottom(false);
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }

    userDetachedFromBottomRef.current = false;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);

    const rafId = requestAnimationFrame(() => {
      const nextContainer = scrollContainerRef.current;
      if (!nextContainer) {
        return;
      }

      nextContainer.scrollTo({ top: nextContainer.scrollHeight, behavior: 'auto' });
      lastScrollTopRef.current = nextContainer.scrollTop;
    });

    return () => cancelAnimationFrame(rafId);
  }, [forceScrollToBottomKey]);

  // Open restored conversations directly at the bottom. Only animate truly live updates.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    const latestActivityId = activities.length > 0 ? activities[activities.length - 1].id : '';
    const messageDelta = messages.length - prevLengthRef.current;
    const historyHydrated = prevLengthRef.current === 0 && messages.length > 0;
    const activityHydrated = prevLatestActivityIdRef.current.length === 0 && latestActivityId.length > 0;
    const activityStarted = latestActivityId.length > 0 && latestActivityId !== prevLatestActivityIdRef.current;
    const shouldJump = !hasInitializedScrollRef.current || historyHydrated || activityHydrated || messageDelta > 1;
    const stateChanged = messageDelta !== 0 || waiting !== prevWaitingRef.current || activityStarted;

    prevLengthRef.current = messages.length;
    prevWaitingRef.current = waiting;
    prevLatestActivityIdRef.current = latestActivityId;
    hasInitializedScrollRef.current = true;

    if (!stateChanged) {
      return undefined;
    }

    if (userDetachedFromBottomRef.current) {
      return undefined;
    }

    if (!shouldJump && !shouldAutoScrollRef.current) {
      return undefined;
    }

    const scrollBehavior = shouldJump ? 'auto' : nextScrollBehaviorRef.current;
    nextScrollBehaviorRef.current = 'auto';

    let settleRafId = 0;
    const rafId = requestAnimationFrame(() => {
      const nextContainer = scrollContainerRef.current;
      if (!nextContainer) return;

      nextContainer.scrollTo({ top: nextContainer.scrollHeight, behavior: scrollBehavior });
      if (scrollBehavior !== 'auto') {
        return;
      }

      settleRafId = requestAnimationFrame(() => {
        const settledContainer = scrollContainerRef.current;
        if (!settledContainer) return;
        settledContainer.scrollTo({ top: settledContainer.scrollHeight, behavior: 'auto' });
      });
    });

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(settleRafId);
    };
  }, [messages, waiting, activities]);
  
  const sendMessage = useCallback(async (text) => {
    if (!text || !canSend) return;

    shouldAutoScrollRef.current = true;
    userDetachedFromBottomRef.current = false;
    nextScrollBehaviorRef.current = 'smooth';
    setActivities([]);

    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      ts: new Date().toISOString(),
    }]);

    setWaiting(true);

    try {
      if (onSubmitMessage) {
        await onSubmitMessage(text);
        return;
      }

      const encrypted = await encryptInput(text);
      if (encrypted) {
        socket.send(JSON.stringify({ type: 'e2e_input', ...encrypted }));
      }
    } catch (error) {
      console.error('Failed to send chat message:', error);
      setWaiting(false);
    }
  }, [canSend, socket, encryptInput, onSubmitMessage, setActivities, setMessages, setWaiting]);

  const handleSendFile = useCallback(async (file, caption) => {
    if (!canSend || !onSendFile) return;

    shouldAutoScrollRef.current = true;
    userDetachedFromBottomRef.current = false;
    nextScrollBehaviorRef.current = 'smooth';
    setActivities([]);

    const displayText = caption
      ? `${caption}\n📎 ${file.name}|${file.size}`
      : `📎 ${file.name}|${file.size}`;

    setMessages(prev => [...prev, {
      role: 'user',
      content: displayText,
      ts: new Date().toISOString(),
    }]);

    setWaiting(true);

    try {
      await onSendFile(file, caption);
    } catch (error) {
      console.error('Failed to send file:', error);
      setWaiting(false);
    }
  }, [canSend, onSendFile, setActivities, setMessages, setWaiting]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#000', position: 'relative' }}>
      <ChatMessages
        messages={messages}
        activities={activities}
        waiting={waiting}
        assistantName={assistantName}
        scrollContainerRef={scrollContainerRef}
        messagesEndRef={messagesEndRef}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 'calc(max(24px, env(safe-area-inset-bottom)) + 76px)',
          width: '100%',
          maxWidth: 640,
          paddingLeft: 16,
          paddingRight: 24,
          display: 'flex',
          justifyContent: 'flex-end',
          pointerEvents: 'none',
          zIndex: 2,
          boxSizing: 'border-box',
        }}
      >
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(16,16,16,0.92)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            opacity: showScrollToBottom ? 1 : 0,
            transform: showScrollToBottom ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.94)',
            pointerEvents: showScrollToBottom ? 'auto' : 'none',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
          }}
        >
          <ChevronDown
            size={14}
            strokeWidth={2}
            style={{
              opacity: showScrollToBottom ? 1 : 0,
              transform: 'translateY(1px)',
              transition: 'opacity 0.2s ease',
            }}
          />
        </button>
      </div>
      <ChatComposer
        canSend={canSend}
        onSend={sendMessage}
        onSendFile={onSendFile ? handleSendFile : undefined}
        uploadProgress={uploadProgress}
        onAbortUpload={onAbortUpload}
        draftStorageKey={draftStorageKey}
      />
    </div>
  );
}

export default ChannelChat;
