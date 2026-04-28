import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useElectron } from '../hooks/useElectron';

/**
 * Cursor companion: a single morphing element anchored to the system
 * cursor. States: dot → input → loading → response → dot.
 *
 * The native window stays a fixed size (the renderer's canvas); shape
 * morphs happen via CSS transitions on the inner pill element. The
 * cursor pointer-arrow corresponds to (ANCHOR_X, ANCHOR_Y) in
 * window-local coordinates — the same offset used in the main process
 * positioning logic — so the pill's left edge sits right under the
 * pointer.
 */

// Must match cursor-companion.js
const ANCHOR_X = 16;
const ANCHOR_Y = 16;

const ACCENT = '#4B5AFF';
// Pill / response styling mirrors the desktop chat message bubbles:
// 18px radius, 10×14 padding, fontSize 15, lineHeight 1.45 (≈22px),
// system sans (Geist Sans) — see ChatMessage in ChannelChat.jsx.
const PILL_PADDING_X = 14;
const PILL_PADDING_Y = 10;
const INPUT_LINE_HEIGHT = 22;
const PILL_HEIGHT = INPUT_LINE_HEIGHT + PILL_PADDING_Y * 2; // 42
const PILL_RADIUS = 18;
const PILL_MIN_WIDTH = 180;
const PILL_MAX_WIDTH = 280;
const PILL_INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * 5 + PILL_PADDING_Y * 2; // 5 lines + padding = 130
const RESPONSE_MAX_WIDTH = 460;
const RESPONSE_MAX_HEIGHT = 280;
const PILL_FONT_FAMILY = "'Geist Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function CursorCompanionView() {
  const { invoke, on } = useElectron();
  const textareaRef = useRef(null);
  const measureRef = useRef(null);
  const [mode, setMode] = useState('dot');
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState(null);
  const [error, setError] = useState(null);
  const [inputBox, setInputBox] = useState({
    width: PILL_MIN_WIDTH,
    height: PILL_HEIGHT,
    textHeight: INPUT_LINE_HEIGHT,
  });

  // Subscribe to mode changes from the main process.
  useEffect(() => {
    const offMode = on('CURSOR_MODE', (payload) => {
      if (!payload || typeof payload.mode !== 'string') return;
      setMode(payload.mode);
      if (payload.mode === 'input') {
        setPrompt('');
        setReply(null);
        setError(null);
      }
      if (payload.mode === 'dot') {
        setPrompt('');
        setReply(null);
        // Keep `error` so a failed submission/timeout remains briefly
        // visible until the user activates the input again.
      }
    });
    const offReply = on('CURSOR_REPLY', (payload) => {
      if (!payload || typeof payload.content !== 'string') return;
      setReply({ content: payload.content, ts: payload.ts || null });
      setError(null);
    });
    const offTimeout = on('CURSOR_REPLY_TIMEOUT', () => {
      setError('No response after 90 seconds.');
    });
    return () => {
      offMode?.();
      offReply?.();
      offTimeout?.();
    };
  }, [on]);

  // Auto-focus the textarea when entering input mode.
  useEffect(() => {
    if (mode === 'input' && textareaRef.current) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [mode]);

  // Measure prompt synchronously before paint so the pill width never
  // lags the typed character — eliminates the per-keystroke flicker.
  //
  // Width is decided first from the hidden mirror (which measures
  // unwrapped single-line text). Height is always read from the
  // textarea's scrollHeight AFTER the width is pinned, so explicit
  // newlines (Shift+Enter, pasted multi-line text) grow the pill
  // vertically even when the unwrapped width still fits on one line.
  useLayoutEffect(() => {
    if (mode !== 'input') return;
    const measuredWidth = measureRef.current?.scrollWidth || 0;
    const desiredWidth = measuredWidth + PILL_PADDING_X * 2 + 2;
    const nextWidth = Math.min(
      PILL_MAX_WIDTH,
      Math.max(PILL_MIN_WIDTH, desiredWidth),
    );

    let nextTextHeight = INPUT_LINE_HEIGHT;
    const ta = textareaRef.current;
    if (ta) {
      // Pin the textarea to the locked inner width BEFORE reading
      // scrollHeight, so wrapped content is measured against the width
      // it will actually render at. Then read scrollHeight as the source
      // of truth for height — this picks up explicit newlines too.
      const innerWidth = Math.max(8, nextWidth - PILL_PADDING_X * 2);
      ta.style.width = `${innerWidth}px`;
      ta.style.height = '0px';
      nextTextHeight = Math.min(
        PILL_INPUT_MAX_HEIGHT - PILL_PADDING_Y * 2,
        Math.max(INPUT_LINE_HEIGHT, ta.scrollHeight),
      );
      ta.style.height = `${nextTextHeight}px`;
    }

    const nextHeight = Math.max(PILL_HEIGHT, nextTextHeight + PILL_PADDING_Y * 2);
    setInputBox((prev) =>
      prev.width === nextWidth && prev.height === nextHeight && prev.textHeight === nextTextHeight
        ? prev
        : { width: nextWidth, height: nextHeight, textHeight: nextTextHeight },
    );
  }, [mode, prompt]);

  const handleDismiss = useCallback(async () => {
    try { await invoke('CURSOR_DISMISS'); } catch (_) {}
  }, [invoke]);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    try {
      const result = await invoke('CURSOR_SUBMIT', { prompt: trimmed });
      if (!result?.success) {
        setError(result?.error || 'Failed to submit');
      }
    } catch (err) {
      setError(err?.message || 'Failed to submit');
    }
  }, [invoke, prompt]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const pillWidth = mode === 'input'
    ? inputBox.width
    : mode === 'loading'
      ? 64
      : mode === 'response'
        ? RESPONSE_MAX_WIDTH
        : 8;
  const pillHeight = mode === 'input'
    ? inputBox.height
    : mode === 'response'
      ? clampResponseHeight(reply?.content || error || '')
      : mode === 'loading'
        ? PILL_HEIGHT
        : 8;
  const isPill = mode !== 'dot';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        // Default click-through. The main process toggles
        // setIgnoreMouseEvents per-mode; this CSS belt is for the empty
        // areas around the pill itself.
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily: PILL_FONT_FAMILY,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* The morphing element. Anchored so its top-left sits just below
          and to the right of the cursor pointer — pill grows rightward
          (until PILL_MAX_WIDTH) then downward, never above the cursor.
          This matches the convention in cursor-anchored AI surfaces and
          guarantees the pill never clips out of the top of the window. */}
      <div
        style={{
          position: 'absolute',
          left: ANCHOR_X,
          top: mode === 'dot' ? ANCHOR_Y + 4 : ANCHOR_Y,
          width: isPill ? pillWidth : 8,
          height: isPill ? pillHeight : 8,
          borderRadius: isPill ? PILL_RADIUS : '50%',
          background: mode === 'dot'
            ? ACCENT
            : mode === 'input'
              ? ACCENT
              : mode === 'response'
                ? 'rgba(255, 255, 255, 0.08)'
                : 'rgba(15, 15, 18, 0.92)',
          boxShadow: mode === 'dot'
            ? 'none'
            : mode === 'input'
              ? `0 8px 24px rgba(0, 0, 0, 0.32)`
              : `0 0 0 1px rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.42)`,
          backdropFilter: mode === 'response' || mode === 'loading' ? 'blur(14px)' : 'none',
          WebkitBackdropFilter: mode === 'response' || mode === 'loading' ? 'blur(14px)' : 'none',
          color: mode === 'input' ? '#ffffff' : 'rgba(255, 255, 255, 0.9)',
          display: 'flex',
          alignItems: mode === 'response' || mode === 'input' ? 'flex-start' : 'center',
          justifyContent: mode === 'loading' ? 'center' : 'flex-start',
          paddingLeft: isPill ? PILL_PADDING_X : 0,
          paddingRight: isPill ? PILL_PADDING_X : 0,
          paddingTop: mode === 'response'
            ? 10
            : mode === 'input'
              ? PILL_PADDING_Y
              : 0,
          paddingBottom: mode === 'response'
            ? 10
            : mode === 'input'
              ? PILL_PADDING_Y
              : 0,
          pointerEvents: isPill ? 'auto' : 'none',
          overflow: 'hidden',
          transition:
            'width 180ms cubic-bezier(0.22, 1, 0.36, 1), ' +
            'height 220ms cubic-bezier(0.22, 1, 0.36, 1), ' +
            'border-radius 220ms ease, ' +
            'background 200ms ease, ' +
            'box-shadow 200ms ease, ' +
            'padding 180ms ease',
        }}
      >
        {mode === 'input' && (
          <textarea
            ref={textareaRef}
            rows={1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            autoComplete="off"
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
        )}

        {mode === 'loading' && <ActivityDots />}

        {mode === 'response' && reply && (
          <div
            style={{
              flex: '1 1 auto',
              maxHeight: RESPONSE_MAX_HEIGHT - 20,
              overflowY: 'auto',
              fontSize: 15,
              lineHeight: 1.45,
              color: 'rgba(255, 255, 255, 0.9)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
              opacity: 1,
              animation: 'cursor-fade-in 200ms ease both',
            }}
          >
            {reply.content}
          </div>
        )}

        {mode === 'response' && error && !reply && (
          <div
            style={{
              flex: '1 1 auto',
              fontSize: 12,
              color: 'rgba(255, 120, 120, 0.9)',
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Inline error pill rendered next to the dot when the bubble has
          collapsed but an error from the previous turn deserves to stay
          visible. Keeps timeout/submit-failure feedback discoverable. */}
      {mode === 'dot' && error && (
        <div
          style={{
            position: 'absolute',
            left: ANCHOR_X + 14,
            top: ANCHOR_Y + 12,
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

      {/* Hidden mirror element to measure prompt text width with the
          same font metrics as the textarea. Used to grow the pill
          horizontally up to PILL_MAX_WIDTH; beyond that the textarea
          wraps and grows vertically instead. */}
      <span
        ref={measureRef}
        style={{
          position: 'absolute',
          visibility: 'hidden',
          whiteSpace: 'pre',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: `${INPUT_LINE_HEIGHT}px`,
          padding: 0,
          margin: 0,
        }}
      >
        {prompt || ' '}
      </span>

      <style>{`
        @keyframes cursor-fade-in {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

/**
 * 2×2 dot loader, identical to the desktop chat's ActivityDots
 * indicator (see ChannelChat.jsx). Sequential active idx 0→1→3→2
 * traces a clockwise rotation; opacity + scale transition each step.
 */
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
    background: ACCENT,
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

function clampResponseHeight(content) {
  if (!content) return PILL_HEIGHT;
  // Rough estimate: 20px per line, ~50 chars per line at 13px mono.
  const approxLines = Math.max(1, Math.ceil(content.length / 50));
  const estHeight = 20 + approxLines * 20;
  return Math.min(RESPONSE_MAX_HEIGHT, Math.max(40, estHeight));
}

export default CursorCompanionView;
