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
// The expanded pill starts just wide enough to host the cursor as an
// affordance — narrow, dot-adjacent, not a fixed-width box. Then it
// grows naturally with the typed content.
const PILL_MIN_WIDTH = 64;
const PILL_MAX_WIDTH = 260;
const PILL_INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * 5 + PILL_PADDING_Y * 2; // 5 lines + padding = 130
const RESPONSE_MAX_WIDTH = 460;
const RESPONSE_MAX_HEIGHT = 280;
const RESPONSE_PADDING_X = 14;
const RESPONSE_PADDING_Y = 10;
const PILL_FONT_FAMILY = "'Geist Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function CursorCompanionView() {
  const { invoke, on } = useElectron();
  const textareaRef = useRef(null);
  // Hidden mirror for unwrapped single-line width. Drives pill width.
  const widthMirrorRef = useRef(null);
  // Hidden mirror constrained to the locked PILL_MAX_WIDTH inner space,
  // wrapping with the same font/wrap rules as the textarea. Drives pill
  // height for both wrapped content AND content with explicit newlines.
  const wrapMirrorRef = useRef(null);
  // Hidden mirror that renders response content at the response inner
  // width with identical font/line-height/wrap rules. Drives the
  // response pill's outer height so it hugs content with no slack.
  const responseMirrorRef = useRef(null);
  const [mode, setMode] = useState('dot');
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState(null);
  const [error, setError] = useState(null);
  const [inputBox, setInputBox] = useState({
    width: PILL_MIN_WIDTH,
    height: PILL_HEIGHT,
    textHeight: INPUT_LINE_HEIGHT,
  });
  const [responseHeight, setResponseHeight] = useState(PILL_HEIGHT);

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
    return () => {
      offMode?.();
      offReply?.();
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

  // Measure prompt synchronously before paint, BEFORE first render
  // commits, using two hidden mirrors. No DOM mutations on the textarea
  // itself — both width and height are React-state-driven so the outer
  // pill and inner textarea always update in the same paint frame and
  // never disagree, which was the root cause of the per-keystroke
  // flicker.
  //
  // Width comes from the single-line `widthMirrorRef`. Height comes
  // from the wrap-locked `wrapMirrorRef` whenever the content would
  // wrap or contains explicit newlines; otherwise it's exactly one
  // line. The wrap mirror has identical font + width constraints as
  // the textarea will have, so its rendered height is what the
  // textarea will render at.
  useLayoutEffect(() => {
    if (mode !== 'input') return;
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
  }, [mode, prompt]);

  // Measure response content height before paint so the pill hugs the
  // text with no extra padding underneath. Outer height = inner content
  // height + 2 × RESPONSE_PADDING_Y, clamped to RESPONSE_MAX_HEIGHT.
  useLayoutEffect(() => {
    if (mode !== 'response') return;
    const content = reply?.content || error || '';
    if (!content) {
      setResponseHeight(PILL_HEIGHT);
      return;
    }
    const measured = responseMirrorRef.current?.offsetHeight || INPUT_LINE_HEIGHT;
    const next = Math.min(
      RESPONSE_MAX_HEIGHT,
      Math.max(PILL_HEIGHT, measured + RESPONSE_PADDING_Y * 2),
    );
    setResponseHeight((prev) => (prev === next ? prev : next));
  }, [mode, reply, error]);

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

  // Renderer-side double-Alt fallback: when the cursor-companion
  // window has keyboard focus (input mode), macOS treats Option as a
  // dead-key for compose input and uiohook-napi can miss the discrete
  // keydown. Detect double-tap-Alt locally here so the toggle still
  // collapses input → dot.
  const altTapAtRef = useRef(0);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
      return;
    }
    if (e.key === 'Alt') {
      const now = Date.now();
      if (now - altTapAtRef.current <= 320) {
        altTapAtRef.current = 0;
        e.preventDefault();
        handleDismiss();
      } else {
        altTapAtRef.current = now;
      }
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
      ? 12
      : mode === 'response'
        ? RESPONSE_MAX_WIDTH
        : 8;
  const pillHeight = mode === 'input'
    ? inputBox.height
    : mode === 'response'
      ? responseHeight
      : mode === 'loading'
        ? 12
        : 8;
  const isPill = mode === 'input' || mode === 'response';

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
      {/* The morphing element. All modes share the same south-east
          offset of the cursor pointer hot spot so the bubble grows from
          where the dot is, never teleports under the cursor. */}
      <div
        style={{
          position: 'absolute',
          left: ANCHOR_X + 14,
          top: ANCHOR_Y + 18,
          width: isPill ? pillWidth : 8,
          height: isPill ? pillHeight : 8,
          borderRadius: isPill ? PILL_RADIUS : '50%',
          background: mode === 'dot'
            ? ACCENT
            : mode === 'input'
              ? ACCENT
              : mode === 'response'
                ? 'rgba(20, 20, 24, 0.92)'
                : 'transparent',
          boxShadow: mode === 'dot' || mode === 'loading'
            ? 'none'
            : mode === 'input'
              ? `0 8px 24px rgba(0, 0, 0, 0.32)`
              : `0 0 0 1px rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.42)`,
          backdropFilter: mode === 'response' ? 'blur(14px)' : 'none',
          WebkitBackdropFilter: mode === 'response' ? 'blur(14px)' : 'none',
          color: mode === 'input' ? '#ffffff' : 'rgba(255, 255, 255, 0.9)',
          display: 'flex',
          alignItems: mode === 'response' || mode === 'input' ? 'flex-start' : 'center',
          justifyContent: mode === 'loading' ? 'center' : 'flex-start',
          paddingLeft: isPill ? PILL_PADDING_X : 0,
          paddingRight: isPill ? PILL_PADDING_X : 0,
          paddingTop: mode === 'response'
            ? RESPONSE_PADDING_Y
            : mode === 'input'
              ? PILL_PADDING_Y
              : 0,
          paddingBottom: mode === 'response'
            ? RESPONSE_PADDING_Y
            : mode === 'input'
              ? PILL_PADDING_Y
              : 0,
          pointerEvents: isPill ? 'auto' : 'none',
          overflow: 'hidden',
          transition:
            mode === 'input'
              // While typing, BOTH width and height must be instant so
              // the outer pill and the React-driven textarea stay in
              // lockstep across the wrap boundary. Animating width
              // caused the textarea (width: 100%) to be mid-animation
              // while the height calc assumed the final locked width,
              // wrapping content to 2 lines inside a 1-line pill —
              // the per-keystroke flicker at the right edge.
              ? 'border-radius 220ms ease, ' +
                'background 200ms ease, ' +
                'box-shadow 200ms ease, ' +
                'padding 180ms ease'
              : 'width 180ms cubic-bezier(0.22, 1, 0.36, 1), ' +
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
              maxHeight: RESPONSE_MAX_HEIGHT - RESPONSE_PADDING_Y * 2,
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

      {/* Hidden single-line mirror — drives pill width via scrollWidth
          of unwrapped content. */}
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
      {/* Hidden response mirror — drives response pill outer height so
          it hugs content instead of using a rough estimate. Width is
          locked to the response inner width; font + lineHeight match
          the visible response container exactly. */}
      <div
        ref={responseMirrorRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          width: `${RESPONSE_MAX_WIDTH - RESPONSE_PADDING_X * 2}px`,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: 1.45,
          padding: 0,
          margin: 0,
          left: 0,
          top: 0,
        }}
      >
        {reply?.content || error || ' '}
      </div>
      {/* Hidden wrapped mirror — drives pill height when content wraps
          or contains explicit newlines. Width is locked to the
          textarea's eventual inner width at PILL_MAX_WIDTH, font and
          wrap rules match the textarea exactly. */}
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

export default CursorCompanionView;
