import { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useElectron } from '../hooks/useElectron';

// Markdown renderer scoped to the cursor reply bubble only. Mirrors the
// styling of ChannelChat's MessageMarkdown so replies feel consistent
// across surfaces, but kept self-contained here to avoid coupling the
// cursor surface to the chat surface.
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
const PILL_PADDING_Y = 8;
const INPUT_LINE_HEIGHT = 22;
const PILL_HEIGHT = INPUT_LINE_HEIGHT + PILL_PADDING_Y * 2; // 42
const PILL_RADIUS = 18;
// The expanded pill starts just wide enough to host the cursor as an
// affordance — narrow, dot-adjacent, not a fixed-width box. Then it
// grows naturally with the typed content.
const PILL_MIN_WIDTH = 64;
const PILL_MAX_WIDTH = 260;
const PILL_INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * 5 + PILL_PADDING_Y * 2; // 5 lines + padding = 130
const RESPONSE_MAX_WIDTH = PILL_MAX_WIDTH;
const RESPONSE_MAX_HEIGHT = 280;
// Response padding mirrors ChannelChat MessageBubble (10×14). Right-edge
// padding is moved off the bubble container and onto the scrollable
// inner div so the scrollbar (track) sits flush at the bubble's right
// edge instead of inset by 14px.
const RESPONSE_PADDING_X = 14;
const RESPONSE_PADDING_Y = 8;
const RESPONSE_INNER_RIGHT_PAD = 4;
const PILL_FONT_FAMILY = "'Geist Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function CursorCompanionView() {
  const { invoke, on } = useElectron();
  const textareaRef = useRef(null);
  // Scrollable container inside the response bubble. Drives wheel-driven
  // scroll while the bubble is visible.
  const responseScrollRef = useRef(null);
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
  // True while the textarea has lost focus in input mode. Drives the
  // park-on-blur affordance — main pauses cursor following so the user
  // can move the system cursor onto the bubble and click to refocus.
  const [isBlurred, setIsBlurred] = useState(false);
  const [inputBox, setInputBox] = useState({
    width: PILL_MIN_WIDTH,
    height: PILL_HEIGHT,
    textHeight: INPUT_LINE_HEIGHT,
  });
  const [responseHeight, setResponseHeight] = useState(PILL_HEIGHT);
  const [responseWidth, setResponseWidth] = useState(PILL_MIN_WIDTH);
  // 'enter' plays a fade-in + scale-up; 'exit' plays the reverse just
  // before main closes the window; 'visible' is the steady state with
  // the keyframe animation cleared so other inline styles (blur dim,
  // hover, etc.) can drive opacity without fighting the animation's
  // final frame. The controller drives this via the CURSOR_ENABLED_CHANGED
  // event; useEffect below transitions enter→visible after the keyframe
  // completes.
  const [presenceAnim, setPresenceAnim] = useState('enter');
  useEffect(() => {
    if (presenceAnim !== 'enter') return undefined;
    const t = setTimeout(() => setPresenceAnim('visible'), 240);
    return () => clearTimeout(t);
  }, [presenceAnim]);

  // True for a brief window after a mode change so width/height can
  // animate smoothly across the morph (dot → pill expand, etc). Cleared
  // after the morph window so subsequent keystroke-driven width updates
  // snap rather than animate — prevents the per-keystroke wrap flicker
  // at the right edge while still giving the initial expand a smooth
  // feel.
  const [isMorphing, setIsMorphing] = useState(false);
  useEffect(() => {
    setIsMorphing(true);
    const t = setTimeout(() => setIsMorphing(false), 280);
    return () => clearTimeout(t);
  }, [mode]);

  // Subscribe to mode changes from the main process.
  useEffect(() => {
    const offMode = on('CURSOR_MODE', (payload) => {
      if (!payload || typeof payload.mode !== 'string') return;
      setMode(payload.mode);
      if (payload.mode === 'input') {
        // Restore the persisted draft (12h TTL) so accidentally
        // dismissing a half-written prompt doesn't cost the user the
        // text — Shift+Shift back open and it reappears.
        const restored = typeof payload.draftPrompt === 'string' ? payload.draftPrompt : '';
        setPrompt(restored);
        setReply(null);
        setError(null);
        setIsBlurred(false);
      }
      if (payload.mode === 'dot') {
        setPrompt('');
        setReply(null);
        setIsBlurred(false);
        // Keep `error` so a failed submission/timeout remains briefly
        // visible until the user activates the input again.
      }
    });
    const offReply = on('CURSOR_REPLY', (payload) => {
      if (!payload || typeof payload.content !== 'string') return;
      setReply({ content: payload.content, ts: payload.ts || null });
      setError(null);
    });
    const offError = on('CURSOR_ERROR', (payload) => {
      if (!payload || typeof payload.message !== 'string') return;
      setError(payload.message);
      setReply(null);
    });
    const offEnabled = on('CURSOR_ENABLED_CHANGED', (payload) => {
      if (!payload || typeof payload.enabled !== 'boolean') return;
      setPresenceAnim(payload.enabled ? 'enter' : 'exit');
    });
    return () => {
      offMode?.();
      offReply?.();
      offError?.();
      offEnabled?.();
    };
  }, [on]);

  // Auto-focus the textarea when entering input mode and place caret at
  // end so a restored draft is immediately editable.
  useEffect(() => {
    if (mode === 'input' && textareaRef.current) {
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        try {
          const end = node.value.length;
          node.setSelectionRange(end, end);
        } catch (_) {}
      });
    }
  }, [mode]);

  // Debounced draft sync to main. Lets the tray-side Shift+Shift path
  // dismiss with a current draft even though the renderer wasn't the
  // gesture source.
  useEffect(() => {
    if (mode !== 'input') return undefined;
    const t = setTimeout(() => {
      void invoke('CURSOR_DRAFT_UPDATE', { prompt }).catch(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [prompt, mode, invoke]);

  // Global wheel capture while the response bubble is visible. The
  // bubble travels with the cursor, so the cursor is never *over* the
  // bubble's content — but the bubble's owning window is non-click-
  // through in response mode, which means wheel events anywhere inside
  // the window's bounds land here. We catch them at the document and
  // scroll the response pane directly, regardless of where exactly the
  // cursor sits within the window. Mental model: if a response is on
  // screen, your wheel scrolls it.
  useEffect(() => {
    if (mode !== 'response') return undefined;
    const handler = (e) => {
      const node = responseScrollRef.current;
      if (!node) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * INPUT_LINE_HEIGHT : e.deltaY;
      node.scrollTop += delta;
    };
    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true });
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

  // Measure response content width AND height before paint so the pill
  // hugs short replies horizontally as well as vertically. The mirror
  // is `display: inline-block` with `max-width` set to the same inner
  // content width the scrollable pane would use at full width — the
  // browser shrinks the mirror to natural content width when the
  // content fits in a single line, and caps at max-width when it
  // wraps. offsetWidth gives us exactly the inner width to render at;
  // outerWidth derives from that plus the asymmetric padding used by
  // the scrollable inner div.
  //
  // Outer pill: width = inner + RESPONSE_PADDING_X (left)
  //                            + (RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD) (right)
  //             height = inner content height + 2 × RESPONSE_PADDING_Y
  // Both clamped to PILL_MIN_WIDTH / PILL_HEIGHT (floor) and
  // RESPONSE_MAX_WIDTH / RESPONSE_MAX_HEIGHT (ceiling).
  useLayoutEffect(() => {
    if (mode !== 'response') return;
    const raw = reply?.content || error || '';
    const content = raw.trim();
    if (!content) {
      setResponseHeight(PILL_HEIGHT);
      setResponseWidth(PILL_MIN_WIDTH);
      return;
    }
    const innerHorizPadding = RESPONSE_PADDING_X + (RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD);
    const measuredW = responseMirrorRef.current?.offsetWidth || 0;
    const measuredH = responseMirrorRef.current?.offsetHeight || INPUT_LINE_HEIGHT;
    const nextW = Math.min(
      RESPONSE_MAX_WIDTH,
      Math.max(PILL_MIN_WIDTH, measuredW + innerHorizPadding),
    );
    const nextH = Math.min(
      RESPONSE_MAX_HEIGHT,
      Math.max(PILL_HEIGHT, measuredH + RESPONSE_PADDING_Y * 2),
    );
    setResponseWidth((prev) => (prev === nextW ? prev : nextW));
    setResponseHeight((prev) => (prev === nextH ? prev : nextH));
  }, [mode, reply, error]);

  const handleDismiss = useCallback(async () => {
    // Pass the current prompt so main can persist it as the draft —
    // covers Esc and any other explicit-dismiss path.
    try { await invoke('CURSOR_DISMISS', { prompt }); } catch (_) {}
  }, [invoke, prompt]);

  const handleSubmit = useCallback(async (withScreenshot = false) => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    try {
      const result = await invoke('CURSOR_SUBMIT', { prompt: trimmed, withScreenshot });
      if (!result?.success) {
        setError(result?.error || 'Failed to submit');
      }
    } catch (err) {
      setError(err?.message || 'Failed to submit');
    }
  }, [invoke, prompt]);

  const handleBlur = useCallback(() => {
    setIsBlurred(true);
    void invoke('CURSOR_BLUR_PARK').catch(() => {});
  }, [invoke]);

  const handleFocus = useCallback(() => {
    setIsBlurred(false);
    void invoke('CURSOR_FOCUS_RESUME').catch(() => {});
  }, [invoke]);

  // Click-to-refocus while the bubble is parked. Native click on the
  // textarea focuses it for free; this handler covers clicks landing on
  // the pill padding/border around the textarea.
  const handlePillMouseDown = useCallback((e) => {
    if (mode !== 'input') return;
    if (!isBlurred) return;
    if (e.target === textareaRef.current) return;
    e.preventDefault();
    textareaRef.current?.focus();
  }, [mode, isBlurred]);

  // Renderer-side double-Shift detector. When the cursor-companion
  // panel has keyboard focus (input mode), uIOhook can miss discrete
  // shift up/down events. Detect locally and dispatch the gesture
  // through the unified main-process entry — same lock applies, so the
  // tray-side path's late event is suppressed.
  //
  // Reset the tap timestamp whenever the textarea blurs or the panel
  // leaves input mode. Without this reset, a stale "tap 1" from an
  // earlier interaction can survive into a fresh focus and turn one
  // Shift press into a phantom double-tap.
  const shiftTapAtRef = useRef(0);
  useEffect(() => {
    if (mode !== 'input') {
      shiftTapAtRef.current = 0;
    }
  }, [mode]);
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
      // Auto-repeat fires Shift keydown again while held; that should
      // not advance the double-tap state machine.
      if (e.repeat) return;
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Option+Enter attaches the cursor-area screenshot.
      // Plain Enter sends the prompt only — no vision context.
      handleSubmit(e.altKey === true);
    }
  };

  const pillWidth = mode === 'input'
    ? inputBox.width
    : mode === 'loading'
      ? 22
      : mode === 'response'
        ? responseWidth
        : 6;
  const pillHeight = mode === 'input'
    ? inputBox.height
    : mode === 'response'
      ? responseHeight
      : mode === 'loading'
        ? 22
        : 6;
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
      {/* The morphing element. Dot/input/response share the south-east
          offset (+14,+18) so the bubble grows from where the dot is.
          Loading mode uses a tighter offset (+6,+8) so the 22px
          two-dot indicator's visual center lines up with the 6px dot's
          center horizontally, ~2px higher — feels like an active
          status orbiter instead of a satellite drifting away. */}
      <div
        onMouseDown={handlePillMouseDown}
        style={{
          position: 'absolute',
          left: mode === 'loading' ? ANCHOR_X + 8 : ANCHOR_X + 14,
          top: mode === 'loading' ? ANCHOR_Y + 8 : ANCHOR_Y + 16,
          width: pillWidth,
          height: pillHeight,
          // Presence enter/exit animation. The keyframe controls
          // opacity + transform; the steady state is opacity:1 +
          // scale(1) once the keyframe finishes (animation-fill-mode:
          // forwards in the keyframe definition).
          animation: presenceAnim === 'enter'
            ? 'cursor-presence-enter 220ms cubic-bezier(0.22, 1, 0.36, 1) both'
            : presenceAnim === 'exit'
              ? 'cursor-presence-exit 200ms ease both'
              : undefined,
          transformOrigin: 'top left',
          borderRadius: isPill ? PILL_RADIUS : '50%',
          // Subtle dim while parked-and-blurred so the user gets a
          // visual cue that the pill is awaiting a click to refocus.
          opacity: mode === 'input' && isBlurred ? 0.78 : 1,
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
          // Response bubble drops its container right padding so the
          // scrollbar sits at the very right edge of the bubble. The
          // visual right padding is restored as paddingRight on the
          // inner scrollable div (see below).
          paddingRight: mode === 'response'
            ? 0
            : isPill ? PILL_PADDING_X : 0,
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
            mode === 'input' && !isMorphing
              // Steady-state typing: BOTH width and height must be
              // instant so the outer pill and the React-driven textarea
              // stay in lockstep across the wrap boundary. Animating
              // width caused the textarea (width: 100%) to be
              // mid-animation while the height calc assumed the final
              // locked width, wrapping content to 2 lines inside a
              // 1-line pill — the per-keystroke flicker at the right
              // edge. So once the morph window closes, snap on
              // keystrokes.
              ? 'border-radius 240ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'background 220ms ease, ' +
                'box-shadow 220ms ease, ' +
                'padding 200ms ease'
              // Mode-change morph window (or any non-input mode):
              // animate width/height too so dot → pill, pill → loader,
              // loader → response feel like one continuous element
              // smoothly reshaping rather than a hard snap.
              : 'width 260ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'height 260ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'border-radius 260ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'background 220ms ease, ' +
                'box-shadow 220ms ease, ' +
                'padding 220ms ease',
        }}
      >
        {mode === 'input' && (
          <textarea
            ref={textareaRef}
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
        )}

        {mode === 'loading' && <ActivityDots />}

        {mode === 'response' && reply && (
          <div
            ref={responseScrollRef}
            className="cursor-thin-scroll"
            style={{
              flex: '1 1 auto',
              maxHeight: RESPONSE_MAX_HEIGHT - RESPONSE_PADDING_Y * 2,
              overflowY: 'auto',
              userSelect: 'text',
              opacity: 1,
              animation: 'cursor-fade-in 200ms ease both',
              // Right padding lives on this scrollable inner div instead
              // of the bubble container so the scrollbar (track) sits at
              // the bubble's right edge — content stays inset by the
              // ChannelChat-matched 14px while the scrollbar gets the
              // remaining sliver.
              paddingRight: RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD,
              marginRight: -RESPONSE_INNER_RIGHT_PAD,
            }}
          >
            <CursorReplyMarkdown content={reply.content.trim()} />
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
          it hugs content instead of using a rough estimate. Only
          mounted in response mode; rendering ReactMarkdown on every
          input-mode keystroke caused layout shifts that could steal
          textarea focus / hide the caret. */}
      {mode === 'response' && (
        <div
          ref={responseMirrorRef}
          aria-hidden
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            // inline-block + max-width lets the browser shrink-to-fit
            // for short content (so the bubble can hug horizontally)
            // while still wrapping at the same effective inner width
            // the scrollable pane would use for long content.
            display: 'inline-block',
            maxWidth: `${RESPONSE_MAX_WIDTH - RESPONSE_PADDING_X - (RESPONSE_PADDING_X - RESPONSE_INNER_RIGHT_PAD)}px`,
            fontFamily: 'inherit',
            padding: 0,
            margin: 0,
            left: 0,
            top: 0,
          }}
        >
          <CursorReplyMarkdown content={(reply?.content || error || ' ').trim() || ' '} />
        </div>
      )}
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
 * Two-dot pulse loader, mirrored from the SecurityPanel's TwoDots
 * (next to SECURED_SESSION in the web chat lock popup). Alternates
 * left ↔ right on a 720ms cadence with a 600ms opacity+scale
 * transition. Calmer than a 4-dot rotation in the small footprint —
 * one signal, not four.
 */
function ActivityDots() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setActive((p) => (p + 1) % 2), 720);
    return () => clearInterval(t);
  }, []);

  const dotStyle = (idx) => ({
    width: 5,
    height: 5,
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
