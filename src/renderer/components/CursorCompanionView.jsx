import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip } from 'lucide-react';
import { useElectron } from '../hooks/useElectron';
import { AttachmentPill } from '../../shared/AttachmentPill.jsx';

function PaperclipIcon() {
  return <Paperclip size={14} strokeWidth={2} />;
}

// Markdown renderer scoped to the cursor reply bubble only.
const cursorRemarkPlugins = [remarkGfm];
const CURSOR_MONO = "'SF Mono','Menlo','Consolas','Liberation Mono',monospace";
const cursorMdComponents = {
  p: ({ children }) => (
    <p style={{ marginTop: 0, marginBottom: '0.6em', lineHeight: 1.45, wordBreak: 'break-word' }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'rgba(255,255,255,0.95)' }}>{children}</strong>
  ),
  em: ({ children }) => (<em>{children}</em>),
  code: ({ inline, children }) => {
    if (inline) {
      return (
        <code style={{
          backgroundColor: 'rgba(255,255,255,0.1)',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: CURSOR_MONO,
          border: '1px solid rgba(255,255,255,0.08)',
          wordBreak: 'break-word',
        }}>{children}</code>
      );
    }
    return (
      <code style={{
        display: 'block',
        fontSize: 13,
        fontFamily: CURSOR_MONO,
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
      padding: '10px 12px',
      borderRadius: 8,
      marginTop: '0.4em',
      marginBottom: '0.6em',
      overflowX: 'auto',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>{children}</pre>
  ),
  ul: ({ children }) => (
    <ul style={{ marginTop: '0.4em', marginBottom: '0.6em', paddingLeft: '1.4em', lineHeight: 1.45, listStyleType: 'disc' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ marginTop: '0.4em', marginBottom: '0.6em', paddingLeft: '1.4em', lineHeight: 1.45 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ marginTop: '0.2em', marginBottom: '0.2em' }}>{children}</li>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#8b9aff', textDecoration: 'underline' }}>{children}</a>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: '3px solid rgba(255,255,255,0.25)',
      paddingLeft: '0.8em',
      marginTop: '0.4em',
      marginBottom: '0.6em',
      marginLeft: 0,
      marginRight: 0,
      color: 'rgba(255,255,255,0.7)',
      fontStyle: 'italic',
    }}>{children}</blockquote>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: '0.8em', marginBottom: '0.8em' }} />
  ),
};

const CursorReplyMarkdown = memo(function CursorReplyMarkdown({ content }) {
  return (
    <div className="cursor-reply-md" style={{ fontSize: 15, lineHeight: 1.45, wordBreak: 'break-word', color: 'rgba(255,255,255,0.9)' }}>
      <ReactMarkdown remarkPlugins={cursorRemarkPlugins} components={cursorMdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Geometry — must match cursor-companion.js
const ANCHOR_X = 16;
const ANCHOR_Y = 16;

const ACCENT = '#4B5AFF';
const PILL_PADDING_X = 14;
const PILL_PADDING_Y = 8;
const INPUT_LINE_HEIGHT = 22;
const PILL_HEIGHT = INPUT_LINE_HEIGHT + PILL_PADDING_Y * 2; // 42
const PILL_RADIUS = 18;
const PILL_MIN_WIDTH = 64;
const PILL_MAX_WIDTH = 260;
const PILL_INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * 5 + PILL_PADDING_Y * 2;
const RESPONSE_MAX_WIDTH = PILL_MAX_WIDTH;
const RESPONSE_MAX_HEIGHT = 280;
const RESPONSE_PADDING_X = 14;
const RESPONSE_PADDING_Y = 8;
const RESPONSE_INNER_RIGHT_PAD = 4;
const PILL_FONT_FAMILY = "'Geist Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// Layer geometry
const LAYER_GAP = 8;
const LOADER_SIZE = 22;
const DOT_SIZE = 5;
const STACK_PEEK_OFFSET = 6; // px each older reply is offset down behind the newer one

// Stack anchor: where the topmost layer's top-left sits, relative to cursor.
const STACK_LEFT = ANCHOR_X + 14;
const STACK_TOP = ANCHOR_Y + 18;
const LOADER_LEFT = ANCHOR_X + 8;
const LOADER_TOP = ANCHOR_Y + 10;

function CursorCompanionView() {
  const { invoke, on } = useElectron();
  const textareaRef = useRef(null);
  const widthMirrorRef = useRef(null);
  const wrapMirrorRef = useRef(null);
  // Tracks textarea mount via callback ref. Necessary because the
  // textarea lives inside LayerWrapper, which defers mounting its
  // children by one render after `inputOpen` flips. Without this,
  // the auto-focus effect fires while `textareaRef.current` is still
  // null and never runs again.
  const [textareaMounted, setTextareaMounted] = useState(false);
  const setTextareaRef = useCallback((node) => {
    textareaRef.current = node;
    setTextareaMounted(node !== null);
  }, []);

  // Layered state from main.
  const [loading, setLoading] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [replies, setReplies] = useState([]); // [{ id, content, ts, role }]
  const [isParked, setIsParked] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null);
  // Latest pendingAttachment for the right-click suppression decision —
  // refs avoid the stale-closure problem inside the global mousedown
  // listener wired in main without re-binding the listener every state
  // change.
  const pendingAttachmentRef = useRef(null);
  pendingAttachmentRef.current = pendingAttachment;

  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState(null);
  const [isBlurred, setIsBlurred] = useState(false);
  const [inputBox, setInputBox] = useState({
    width: PILL_MIN_WIDTH,
    height: PILL_HEIGHT,
    textHeight: INPUT_LINE_HEIGHT,
  });
  const [replySizes, setReplySizes] = useState({}); // { [id]: { width, height } }

  // Presence for the whole companion (master toggle).
  const [presenceAnim, setPresenceAnim] = useState('enter');
  useEffect(() => {
    if (presenceAnim !== 'enter') return undefined;
    const t = setTimeout(() => setPresenceAnim('visible'), 240);
    return () => clearTimeout(t);
  }, [presenceAnim]);

  // Subscribe to state and reply events.
  useEffect(() => {
    let sawLiveState = false;
    const offState = on('CURSOR_STATE', (payload) => {
      if (!payload) return;
      sawLiveState = true;
      if (typeof payload.loading === 'boolean') setLoading(payload.loading);
      if (typeof payload.inputOpen === 'boolean') setInputOpen(payload.inputOpen);
      if (Array.isArray(payload.replies)) {
        setReplies(payload.replies);
      }
      if (typeof payload.isParked === 'boolean') setIsParked(payload.isParked);
      if ('pendingAttachment' in payload) setPendingAttachment(payload.pendingAttachment || null);

      // Input just opened — restore draft.
      if (payload.event === 'input_opened') {
        const restored = typeof payload.draftPrompt === 'string' ? payload.draftPrompt : '';
        setPrompt(restored);
        setError(null);
        setIsBlurred(false);
      }
      // Input just closed (dismiss / submit) — clear local prompt buffer.
      if (payload.event === 'input_closed' || payload.event === 'turn_submitted' || payload.event === 'dismissed') {
        setPrompt('');
        setIsBlurred(false);
      }
      // Replies were cleared.
      if (payload.event === 'replies_cleared' || payload.event === 'dismissed') {
        setReplySizes({});
      }
    });

    const offError = on('CURSOR_ERROR', (payload) => {
      if (!payload || typeof payload.message !== 'string') return;
      setError(payload.message);
    });

    const offEnabled = on('CURSOR_ENABLED_CHANGED', (payload) => {
      if (!payload || typeof payload.enabled !== 'boolean') return;
      setPresenceAnim(payload.enabled ? 'enter' : 'exit');
    });

    const offRightClick = on('CURSOR_RIGHT_CLICK', () => {
      // Right-click anywhere while replies are visible dismisses the
      // topmost. The bubble travels with the cursor, so hit-testing
      // the click against the bubble's rect would always fail by
      // design — the cursor is never over the bubble it spawned.
      setReplies((curr) => {
        if (curr.length === 0) return curr;
        const top = curr[curr.length - 1];
        void invoke('CURSOR_DISMISS_REPLY', { id: top.id }).catch(() => {});
        return curr;
      });
    });

    // Mount-time hydration: the renderer can miss the initial state
    // broadcast if it loads after main has already opened input (dev
    // HMR reload, slow first paint, etc.). Pull the current state
    // synchronously so we render the right layers from the first frame.
    // If a live CURSOR_STATE event arrives before the snapshot resolves,
    // the live event is fresher — skip the snapshot to avoid clobbering.
    invoke('CURSOR_GET_STATE').then((state) => {
      if (!state || state.ok !== true) return;
      if (sawLiveState) return;
      if (typeof state.loading === 'boolean') setLoading(state.loading);
      if (typeof state.inputOpen === 'boolean') setInputOpen(state.inputOpen);
      if (Array.isArray(state.replies)) setReplies(state.replies);
      if (typeof state.isParked === 'boolean') setIsParked(state.isParked);
      if ('pendingAttachment' in state) setPendingAttachment(state.pendingAttachment || null);
      if (state.inputOpen && typeof state.draftPrompt === 'string') {
        setPrompt(state.draftPrompt);
      }
    }).catch((err) => {
      // Loud on purpose: silent .catch is exactly how the preload
      // allowlist mismatch hid for a session. Surface the same class
      // of regression next time before users hit it.
      console.error('[CURSOR] Failed to hydrate state', err);
    });

    return () => {
      offState?.();
      offError?.();
      offEnabled?.();
      offRightClick?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, invoke]);

  // Auto-focus textarea when input opens. Depends on textareaMounted
  // because LayerWrapper defers mounting the textarea by one render
  // after inputOpen flips — running this effect on inputOpen alone
  // would see textareaRef.current still null and silently skip focus.
  useEffect(() => {
    if (!inputOpen || !textareaMounted) return;
    const node = textareaRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      const live = textareaRef.current;
      if (!live) return;
      live.focus();
      try {
        const end = live.value.length;
        live.setSelectionRange(end, end);
      } catch (_) {}
    });
  }, [inputOpen, textareaMounted]);

  // Debounced draft sync.
  useEffect(() => {
    if (!inputOpen) return undefined;
    const t = setTimeout(() => {
      void invoke('CURSOR_DRAFT_UPDATE', { prompt }).catch(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [prompt, inputOpen, invoke]);

  // Global wheel capture while replies are visible — bubble travels
  // with the cursor (when not parked) so we forward wheel into the
  // topmost reply's scrollable pane.
  const replyScrollRefs = useRef({}); // { [id]: HTMLElement }
  useEffect(() => {
    if (replies.length === 0) return undefined;
    const handler = (e) => {
      const top = replies[replies.length - 1];
      if (!top) return;
      const node = replyScrollRefs.current[top.id];
      if (!node) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * INPUT_LINE_HEIGHT : e.deltaY;
      node.scrollTop += delta;
    };
    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true });
  }, [replies]);

  // Measure prompt for input pill width/height.
  useLayoutEffect(() => {
    if (!inputOpen) return;
    const singleLineWidth = widthMirrorRef.current?.scrollWidth || 0;
    const desiredWidth = singleLineWidth + PILL_PADDING_X * 2 + 2;
    const nextWidth = Math.min(
      PILL_MAX_WIDTH,
      Math.max(PILL_MIN_WIDTH, desiredWidth),
    );

    const wantsWrap = desiredWidth > PILL_MAX_WIDTH;
    const hasNewlines = prompt.includes('\n');
    let nextTextHeight = INPUT_LINE_HEIGHT;
    if (wantsWrap || hasNewlines) {
      const wrapHeight = wrapMirrorRef.current?.offsetHeight || INPUT_LINE_HEIGHT;
      nextTextHeight = Math.min(
        PILL_INPUT_MAX_HEIGHT - PILL_PADDING_Y * 2,
        Math.max(INPUT_LINE_HEIGHT, wrapHeight),
      );
    }

    const nextHeight = Math.max(PILL_HEIGHT, nextTextHeight + PILL_PADDING_Y * 2);
    setInputBox((prev) =>
      prev.width === nextWidth && prev.height === nextHeight && prev.textHeight === nextTextHeight
        ? prev
        : { width: nextWidth, height: nextHeight, textHeight: nextTextHeight },
    );
  }, [inputOpen, prompt]);

  const handleDismiss = useCallback(async () => {
    try { await invoke('CURSOR_DISMISS', { prompt }); } catch (_) {}
  }, [invoke, prompt]);

  // screenshot: 'none' | 'cursor' | 'fullscreen'
  //   none       — plain Enter
  //   cursor     — Option+Enter (800×800 crop centred on cursor)
  //   fullscreen — Option+Shift+Enter (entire display containing the cursor)
  const handleSubmit = useCallback(async (screenshot = 'none') => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    try {
      const result = await invoke('CURSOR_SUBMIT', { prompt: trimmed, screenshot });
      if (!result?.success) {
        setError(result?.error || 'Failed to submit');
      }
    } catch (err) {
      setError(err?.message || 'Failed to submit');
    }
  }, [invoke, prompt]);

  const handleBlur = useCallback(() => {
    setIsBlurred(true);
    // Synchronously persist the draft before parking. Closes the gap
    // between the debounced draft sync and a tray-side dismissal that
    // could otherwise lose the most recent keystroke.
    void invoke('CURSOR_BLUR_PARK', { prompt }).catch(() => {});
  }, [invoke, prompt]);

  const handleFocus = useCallback(() => {
    setIsBlurred(false);
    void invoke('CURSOR_FOCUS_RESUME').catch(() => {});
  }, [invoke]);

  const handlePillMouseDown = useCallback((e) => {
    if (!inputOpen) return;
    if (!isBlurred) return;
    if (e.target === textareaRef.current) return;
    e.preventDefault();
    textareaRef.current?.focus();
  }, [inputOpen, isBlurred]);

  // Renderer-side double-Shift detector.
  const shiftTapAtRef = useRef(0);
  useEffect(() => {
    if (!inputOpen) {
      shiftTapAtRef.current = 0;
    }
  }, [inputOpen]);
  useEffect(() => {
    if (isBlurred) {
      shiftTapAtRef.current = 0;
    }
  }, [isBlurred]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
      return;
    }
    if (e.key === 'Shift') {
      if (e.repeat) return;
      // Alt-held Shift+Shift means annotation invocation — let the tray
      // detector be the source of truth so we don't double-fire (the
      // tray callback decides annotation-vs-input based on alt state;
      // the renderer-side `CURSOR_SHIFT_GESTURE` IPC has no alt info).
      if (e.altKey) {
        shiftTapAtRef.current = 0;
        return;
      }
      const now = Date.now();
      if (now - shiftTapAtRef.current <= 320) {
        shiftTapAtRef.current = 0;
        e.preventDefault();
        void invoke('CURSOR_SHIFT_GESTURE', { prompt }).catch(() => {});
      } else {
        shiftTapAtRef.current = now;
      }
      return;
    }
    // Reset double-shift tracker on any non-Shift key — protects against
    // Shift-for-capitalization → quick second Shift being misread as
    // Shift+Shift.
    if (e.key !== 'Shift') {
      shiftTapAtRef.current = 0;
    }
    if (e.key === 'Enter' && !e.nativeEvent?.isComposing) {
      // Plain Enter:           text only
      // Option+Enter:          cursor-area crop
      // Option+Shift+Enter:    full screen
      // Shift+Enter (no alt):  newline (default textarea behaviour)
      // Cmd/Ctrl+Enter:        ignored — leave for OS / future binding
      if (e.metaKey || e.ctrlKey) return;
      if (e.shiftKey && !e.altKey) return;
      e.preventDefault();
      const screenshot = e.altKey
        ? (e.shiftKey ? 'fullscreen' : 'cursor')
        : 'none';
      handleSubmit(screenshot);
    }
  };

  // Per-reply right-click handler — local so it identifies which reply.
  // Suppressed when an attachment is queued: main's global mousedown
  // owns the dismissal precedence (attachment first, then top reply).
  const handleReplyContextMenu = useCallback((replyId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pendingAttachmentRef.current) return;
    void invoke('CURSOR_DISMISS_REPLY', { id: replyId }).catch(() => {});
  }, [invoke]);

  const interactiveActive = inputOpen || replies.length > 0 || Boolean(pendingAttachment);

  // Report current hit-regions (window-local coords) to main on every
  // layout-affecting change. Main's 60Hz cursor poll uses these to
  // toggle setIgnoreMouseEvents synchronously — eliminates the
  // mousemove → IPC roundtrip lag that let wheel events leak through.
  useLayoutEffect(() => {
    const regions = [];
    if (interactiveActive) {
      const nodes = document.querySelectorAll('[data-cursor-hit-region="true"]');
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number.parseFloat(style.opacity || '1') <= 0.02) continue;
        regions.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    }
    void invoke('CURSOR_REPORT_HIT_REGIONS', { regions }).catch(() => {});
  }, [interactiveActive, inputBox, pendingAttachment, replies, replySizes, invoke]);

  // Compute which layers are active and their vertical offsets.
  // Layer order top→bottom: loader, input, attachment-pill, reply-stack.
  const showDot = !loading && !inputOpen && replies.length === 0 && !pendingAttachment;
  const ATTACHMENT_PILL_HEIGHT = 32; // matches AttachmentPill padding+font

  // Measured stack heights for layout. Reply stack outer height = topmost
  // reply's measured height + (count-1)*peek.
  const topReply = replies.length > 0 ? replies[replies.length - 1] : null;
  const topReplySize = topReply ? (replySizes[topReply.id] || { width: PILL_MIN_WIDTH, height: PILL_HEIGHT }) : null;
  const stackOuterHeight = topReplySize
    ? topReplySize.height + (replies.length - 1) * STACK_PEEK_OFFSET
    : 0;

  // Vertical positions of each layer (anchored at STACK_TOP).
  let cursor = STACK_TOP;
  const positions = {};
  if (loading) {
    // Loader is positioned independently with its own offset to keep the
    // 22px box visually centred on the cursor when it's the only thing
    // visible. When stacked above other layers, we still use LOADER_TOP
    // for the loader and offset subsequent layers below it.
    positions.loader = { left: LOADER_LEFT, top: LOADER_TOP };
    cursor = LOADER_TOP + LOADER_SIZE + LAYER_GAP;
  }
  if (inputOpen) {
    positions.input = { left: STACK_LEFT, top: cursor };
    cursor += inputBox.height + LAYER_GAP;
  }
  if (pendingAttachment) {
    positions.attachment = { left: STACK_LEFT, top: cursor };
    cursor += ATTACHMENT_PILL_HEIGHT + LAYER_GAP;
  }
  if (replies.length > 0) {
    positions.replyStack = { left: STACK_LEFT, top: cursor };
    cursor += stackOuterHeight + LAYER_GAP;
  }
  if (showDot) {
    positions.dot = { left: STACK_LEFT, top: STACK_TOP };
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily: PILL_FONT_FAMILY,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Dot layer */}
      <LayerWrapper visible={showDot} duration={220}>
        {(state) => (
          <div
            style={{
              position: 'absolute',
              left: STACK_LEFT,
              top: STACK_TOP,
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: '50%',
              backgroundColor: ACCENT,
              opacity: state === 'visible' ? 1 : 0,
              transform: state === 'visible' ? 'scale(1)' : 'scale(0.65)',
              transition: 'opacity 200ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
              transformOrigin: 'top left',
              animation: presenceAnim === 'enter' ? 'cursor-presence-enter 220ms cubic-bezier(0.22, 1, 0.36, 1) both'
                : presenceAnim === 'exit' ? 'cursor-presence-exit 200ms ease both' : undefined,
              pointerEvents: 'none',
            }}
          />
        )}
      </LayerWrapper>

      {/* Loader layer */}
      <LayerWrapper visible={loading} duration={220}>
        {(state) => (
          <div
            style={{
              position: 'absolute',
              left: positions.loader?.left ?? LOADER_LEFT,
              top: positions.loader?.top ?? LOADER_TOP,
              width: LOADER_SIZE,
              height: LOADER_SIZE,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: state === 'visible' ? 1 : 0,
              transform: state === 'visible' ? 'scale(1)' : 'scale(0.7)',
              transition: 'opacity 200ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), top 240ms cubic-bezier(0.22, 1, 0.36, 1)',
              transformOrigin: 'top left',
              pointerEvents: 'none',
            }}
          >
            <ActivityDots />
          </div>
        )}
      </LayerWrapper>

      {/* Input pill layer */}
      <LayerWrapper visible={inputOpen} duration={220}>
        {(state) => (
          <div
            data-cursor-hit-region="true"
            onMouseDown={handlePillMouseDown}
            style={{
              position: 'absolute',
              left: positions.input?.left ?? STACK_LEFT,
              top: positions.input?.top ?? STACK_TOP,
              width: inputBox.width,
              height: inputBox.height,
              borderRadius: PILL_RADIUS,
              background: ACCENT,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.32)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'flex-start',
              paddingLeft: PILL_PADDING_X,
              paddingRight: PILL_PADDING_X,
              paddingTop: PILL_PADDING_Y,
              paddingBottom: PILL_PADDING_Y,
              overflow: 'hidden',
              opacity: state === 'visible' ? (isBlurred ? 0.78 : 1) : 0,
              transform: state === 'visible' ? 'scale(1)' : 'scale(0.85)',
              transformOrigin: 'top left',
              transition: 'opacity 200ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), top 240ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 240ms cubic-bezier(0.22, 1, 0.36, 1), background 220ms ease, box-shadow 220ms ease',
              pointerEvents: 'auto',
            }}
          >
            <textarea
              ref={setTextareaRef}
              rows={1}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={handleBlur}
              onFocus={handleFocus}
              spellCheck={false}
              autoComplete="off"
              className="cursor-thin-scroll"
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                width: '100%',
                height: inputBox.textHeight,
                maxHeight: PILL_INPUT_MAX_HEIGHT - PILL_PADDING_Y * 2,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                padding: 0,
                margin: 0,
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 15,
                lineHeight: `${INPUT_LINE_HEIGHT}px`,
                resize: 'none',
                overflowY: inputBox.height >= PILL_INPUT_MAX_HEIGHT ? 'auto' : 'hidden',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                userSelect: 'text',
              }}
            />
          </div>
        )}
      </LayerWrapper>

      {/* Pending attachment layer — shown between input and replies */}
      <LayerWrapper visible={Boolean(pendingAttachment)} duration={220}>
        {(state) => (
          <div
            data-cursor-hit-region="true"
            style={{
              position: 'absolute',
              left: positions.attachment?.left ?? STACK_LEFT,
              top: positions.attachment?.top ?? STACK_TOP,
              width: PILL_MAX_WIDTH,
              opacity: state === 'visible' ? 1 : 0,
              transform: state === 'visible' ? 'scale(1)' : 'scale(0.85)',
              transformOrigin: 'top left',
              transition: 'opacity 200ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), top 240ms cubic-bezier(0.22, 1, 0.36, 1)',
              pointerEvents: 'auto',
              background: 'rgba(20, 20, 24, 0.92)',
              borderRadius: PILL_RADIUS,
              padding: '4px 4px',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.42)',
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void invoke('CURSOR_DISMISS_ATTACHMENT').catch(() => {});
            }}
          >
            {pendingAttachment ? (
              <AttachmentPill
                name={pendingAttachment.name}
                size={pendingAttachment.size}
                icon={<PaperclipIcon />}
              />
            ) : null}
          </div>
        )}
      </LayerWrapper>

      {/* Reply stack layer */}
      <LayerWrapper visible={replies.length > 0} duration={220}>
        {(state) => (
          <ReplyStack
            replies={replies}
            origin={positions.replyStack || { left: STACK_LEFT, top: STACK_TOP }}
            visible={state === 'visible'}
            onContextMenu={handleReplyContextMenu}
            scrollRefs={replyScrollRefs}
            onMeasure={(id, size) => {
              setReplySizes((prev) => {
                const existing = prev[id];
                if (existing && existing.width === size.width && existing.height === size.height) return prev;
                return { ...prev, [id]: size };
              });
            }}
          />
        )}
      </LayerWrapper>

      {/* Error pill rendered next to the dot when nothing else is visible. */}
      {showDot && error && (
        <div
          style={{
            position: 'absolute',
            left: STACK_LEFT,
            top: STACK_TOP + 8,
            padding: '4px 10px',
            background: 'rgba(35, 12, 14, 0.92)',
            color: 'rgba(255, 130, 130, 0.92)',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            boxShadow: '0 0 0 1px rgba(255, 80, 80, 0.18), 0 4px 14px rgba(0, 0, 0, 0.32)',
            pointerEvents: 'none',
            animation: 'cursor-fade-in 200ms ease both',
          }}
        >
          {error}
        </div>
      )}

      {/* Hidden mirrors for input width/height measurement. */}
      <span
        ref={widthMirrorRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: `${INPUT_LINE_HEIGHT}px`,
          padding: 0,
          margin: 0,
          left: 0,
          top: 0,
        }}
      >
        {prompt || ' '}
      </span>
      <div
        ref={wrapMirrorRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          width: `${PILL_MAX_WIDTH - PILL_PADDING_X * 2}px`,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: `${INPUT_LINE_HEIGHT}px`,
          padding: 0,
          margin: 0,
          left: 0,
          top: 0,
        }}
      >
        {prompt || ' '}
      </div>

      <style>{`
        @keyframes cursor-fade-in {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes cursor-presence-enter {
          from { opacity: 0; transform: scale(0.65); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes cursor-presence-exit {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.65); }
        }
        .cursor-thin-scroll::-webkit-scrollbar {
          width: 4px;
          height: 4px;
        }
        .cursor-thin-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .cursor-thin-scroll::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.18);
          border-radius: 999px;
        }
        .cursor-thin-scroll::-webkit-scrollbar-thumb:hover {
          background-color: rgba(255, 255, 255, 0.32);
        }
        .cursor-reply-md > *:first-child { margin-top: 0 !important; }
        .cursor-reply-md > *:last-child { margin-bottom: 0 !important; }
      `}</style>
    </div>
  );
}

/**
 * LayerWrapper — handles enter/exit animation for a single layer.
 *
 * Children prop receives the current presence state ('entering',
 * 'visible', 'exiting') so the child element can drive its own
 * transitions. Unmounts the child after the exit duration so the
 * underlying DOM is clean.
 */
function LayerWrapper({ visible, duration = 220, children }) {
  const [shouldRender, setShouldRender] = useState(visible);
  const [state, setState] = useState(visible ? 'visible' : 'exiting');

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      // Next frame, switch to visible so transitions run from the
      // initial styles to the visible styles.
      const r = requestAnimationFrame(() => setState('visible'));
      return () => cancelAnimationFrame(r);
    }
    // Exiting: keep mounted, switch state, unmount after duration.
    setState('exiting');
    const t = setTimeout(() => setShouldRender(false), duration);
    return () => clearTimeout(t);
  }, [visible, duration]);

  // When initially mounted, ensure first frame is 'entering' so the
  // transition has a starting point to animate from.
  useEffect(() => {
    if (visible && shouldRender && state === 'visible') {
      // already applied
    }
  }, [visible, shouldRender, state]);

  if (!shouldRender) return null;
  return children(state);
}

/**
 * ReplyStack — renders the reply deck. Latest on top, older replies
 * peeking from below by STACK_PEEK_OFFSET each. Each reply's bubble is
 * absolutely positioned within the stack outer.
 */
function ReplyStack({ replies, origin, visible, onContextMenu, scrollRefs, onMeasure }) {
  // Order: replies[0] = oldest, replies[last] = newest.
  // Newest sits at z-top fully visible; older are offset down behind it.
  const count = replies.length;

  return (
    <div
      style={{
        position: 'absolute',
        left: origin.left,
        top: origin.top,
        opacity: visible ? 1 : 0,
        transition: 'opacity 200ms ease, top 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: 'auto',
      }}
    >
      {replies.map((reply, idx) => {
        const fromTop = count - 1 - idx; // 0 for newest, increases for older
        // Newest at z-top, older behind. Older offset DOWN by peek so
        // their bottom edge sticks out below the newer one.
        const z = idx; // higher idx = newer = on top in stack but... we want older to peek
        // Actually: newer should be visually on TOP (z-index higher), with older offset down.
        // Newer = idx=count-1. Older = idx=0.
        // To make older "peek from below the newer": render older translated DOWN, with z-index LOWER.
        // Easier: position newer at top: 0, older at top: peek*fromTop.
        // But for "peek from bottom" — we want OLDER reply to extend below newer's bottom edge.
        // So older sits LOWER and BEHIND. translateY(peek * (count-1-idx)).
        const offsetY = fromTop * STACK_PEEK_OFFSET;
        const isTop = fromTop === 0;
        return (
          <ReplyBubble
            key={reply.id}
            reply={reply}
            offsetY={offsetY}
            zIndex={idx}
            isTop={isTop}
            onContextMenu={onContextMenu(reply.id)}
            scrollRefSetter={(node) => {
              if (node) scrollRefs.current[reply.id] = node;
              else delete scrollRefs.current[reply.id];
            }}
            onMeasure={onMeasure}
          />
        );
      })}
    </div>
  );
}

const ReplyBubble = memo(function ReplyBubble({
  reply, offsetY, zIndex, isTop, onContextMenu, scrollRefSetter, onMeasure,
}) {
  const mirrorRef = useRef(null);
  const naturalMirrorRef = useRef(null);
  const [size, setSize] = useState({ width: PILL_MIN_WIDTH, height: PILL_HEIGHT });

  useLayoutEffect(() => {
    const innerHorizPadding = RESPONSE_PADDING_X + (RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD);
    const maxInner = RESPONSE_MAX_WIDTH - innerHorizPadding;
    const naturalW = naturalMirrorRef.current?.offsetWidth || 0;
    const measuredW = mirrorRef.current?.offsetWidth || 0;
    const measuredH = mirrorRef.current?.offsetHeight || INPUT_LINE_HEIGHT;
    // If unwrapped content would exceed max inner width, lock the bubble to
    // RESPONSE_MAX_WIDTH so wrapped paragraphs visually align with the input
    // pill at full width. Otherwise hug the constrained measurement.
    const nextW = naturalW > maxInner
      ? RESPONSE_MAX_WIDTH
      : Math.min(
          RESPONSE_MAX_WIDTH,
          Math.max(PILL_MIN_WIDTH, measuredW + innerHorizPadding),
        );
    const nextH = Math.min(
      RESPONSE_MAX_HEIGHT,
      Math.max(PILL_HEIGHT, measuredH + RESPONSE_PADDING_Y * 2),
    );
    setSize((prev) => (prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }));
    onMeasure(reply.id, { width: nextW, height: nextH });
  }, [reply.id, reply.content, onMeasure]);

  return (
    <>
      <div
        data-cursor-hit-region={isTop ? 'true' : undefined}
        onContextMenu={onContextMenu}
        style={{
          position: 'absolute',
          left: 0,
          top: offsetY,
          width: size.width,
          height: size.height,
          borderRadius: PILL_RADIUS,
          background: 'rgba(20, 20, 24, 0.92)',
          boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.42)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          color: 'rgba(255, 255, 255, 0.9)',
          display: 'flex',
          alignItems: 'flex-start',
          paddingLeft: RESPONSE_PADDING_X,
          paddingRight: 0,
          paddingTop: RESPONSE_PADDING_Y,
          paddingBottom: RESPONSE_PADDING_Y,
          overflow: 'hidden',
          zIndex,
          opacity: isTop ? 1 : 0.78,
          transition: 'top 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease, width 240ms ease, height 240ms ease',
          pointerEvents: isTop ? 'auto' : 'none',
        }}
      >
        <div
          ref={scrollRefSetter}
          className="cursor-thin-scroll"
          style={{
            flex: '1 1 auto',
            maxHeight: RESPONSE_MAX_HEIGHT - RESPONSE_PADDING_Y * 2,
            overflowY: isTop ? 'auto' : 'hidden',
            userSelect: 'text',
            paddingRight: RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD,
            marginRight: -RESPONSE_INNER_RIGHT_PAD,
          }}
        >
          <CursorReplyMarkdown content={(reply.content || '').trim()} />
        </div>
      </div>
      {/* Hidden mirror — measures content at max-width to determine wrapped height.
          width:max-content escapes the narrow companion-window containing block;
          maxWidth caps the wrap width so multi-line measurements are correct. */}
      <div
        ref={mirrorRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          display: 'block',
          width: 'max-content',
          maxWidth: `${RESPONSE_MAX_WIDTH - RESPONSE_PADDING_X - (RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD)}px`,
          fontFamily: 'inherit',
          padding: 0,
          margin: 0,
          left: 0,
          top: 0,
        }}
      >
        <CursorReplyMarkdown content={(reply.content || ' ').trim() || ' '} />
      </div>
      {/* Natural mirror — measures unwrapped paragraph width to detect overflow.
          If the widest natural line exceeds the inner max, we lock to max-width
          so wrapped content aligns with the input pill instead of hugging short.
          width:max-content escapes the narrow companion-window containing block
          so the measurement reflects intrinsic content width, not parent width. */}
      <div
        ref={naturalMirrorRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          display: 'block',
          width: 'max-content',
          fontFamily: 'inherit',
          padding: 0,
          margin: 0,
          left: 0,
          top: 0,
        }}
      >
        <CursorReplyMarkdown content={(reply.content || ' ').trim() || ' '} />
      </div>
    </>
  );
});

/**
 * Two-dot pulse loader — same size as the main dot (5×5) with a 4px gap.
 * Alternates left ↔ right on a 720ms cadence.
 */
function ActivityDots() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setActive((p) => (p + 1) % 2), 720);
    return () => clearInterval(t);
  }, []);

  const dotStyle = (idx) => ({
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: '50%',
    backgroundColor: ACCENT,
    opacity: active === idx ? 1 : 0.18,
    transform: active === idx ? 'scale(1)' : 'scale(0.78)',
    transition: 'opacity 0.6s ease, transform 0.6s ease',
  });

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
      <div style={dotStyle(0)} />
      <div style={dotStyle(1)} />
    </div>
  );
}

export default CursorCompanionView;
