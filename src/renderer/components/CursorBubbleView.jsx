import { useEffect, useRef, useState, useCallback } from 'react';
import { useElectron } from '../hooks/useElectron';

/**
 * The cursor companion's interactive bubble. Opens next to the cursor on
 * Option+Option, accepts a single-turn prompt, sends it through the main
 * process (which captures the cursor-area screenshot and forwards via the
 * existing channel-bridge to Claude Code), then renders the reply in the
 * same bubble.
 *
 * Visual: matching RO chrome — dark, mono, #4B5AFF accent. Single-turn
 * affordance: no scrollback, no history. Esc dismisses.
 */
function CursorBubbleView() {
  const { invoke, on } = useElectron();
  const inputRef = useRef(null);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | sending | waiting | answered | error
  const [error, setError] = useState(null);
  const [reply, setReply] = useState(null);

  // Focus the input on mount so the user can start typing immediately.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Subscribe to reply events from the main process.
  useEffect(() => {
    const off = on('CURSOR_REPLY', (payload) => {
      if (!payload || typeof payload.content !== 'string') return;
      setReply({ content: payload.content, ts: payload.ts || null });
      setPhase('answered');
    });
    const offTimeout = on('CURSOR_REPLY_TIMEOUT', () => {
      setError('No response after 90 seconds. The agent may still be working — try again.');
      setPhase('error');
    });
    return () => {
      off?.();
      offTimeout?.();
    };
  }, [on]);

  const handleDismiss = useCallback(async () => {
    try {
      await invoke('CURSOR_DISMISS');
    } catch (_) {
      // Window will close regardless; ignore
    }
  }, [invoke]);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || phase === 'sending' || phase === 'waiting') {
      return;
    }
    setPhase('sending');
    setError(null);
    setReply(null);
    try {
      const result = await invoke('CURSOR_SUBMIT', { prompt: trimmed });
      if (result?.success) {
        setPhase('waiting');
      } else {
        setError(result?.error || 'Failed to submit');
        setPhase('error');
      }
    } catch (err) {
      setError(err?.message || 'Failed to submit');
      setPhase('error');
    }
  }, [invoke, phase, prompt]);

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

  const isBusy = phase === 'sending' || phase === 'waiting';
  const statusLine = phase === 'sending'
    ? 'Capturing & sending…'
    : phase === 'waiting'
      ? 'Working…'
      : phase === 'error'
        ? error
        : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 10, 12, 0.94)',
        borderRadius: 10,
        boxShadow:
          '0 0 0 1px rgba(75, 90, 255, 0.25), ' +
          '0 12px 32px rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        color: '#e6e6f0',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.45,
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
        boxSizing: 'border-box',
        overflow: 'hidden',
        userSelect: 'none',
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: '#4B5AFF',
          marginBottom: 8,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#4B5AFF',
            boxShadow: '0 0 6px 1px rgba(75, 90, 255, 0.5)',
          }}
        />
        <span>Cursor companion</span>
      </div>

      {phase !== 'answered' && (
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isBusy}
          placeholder="Ask about what you're pointing at…"
          rows={3}
          spellCheck={false}
          style={{
            flex: '1 1 auto',
            width: '100%',
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 6,
            padding: 8,
            color: '#e6e6f0',
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
            userSelect: 'text',
          }}
        />
      )}

      {phase === 'answered' && reply && (
        <div
          style={{
            flex: '1 1 auto',
            overflow: 'auto',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: 6,
            padding: 8,
            color: '#e6e6f0',
            fontSize: 13,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
          }}
        >
          {reply.content}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 8,
          fontSize: 11,
          color: 'rgba(230, 230, 240, 0.55)',
        }}
      >
        <span>
          {statusLine ?? (phase === 'answered'
            ? 'Esc to dismiss · Option+Option to ask again'
            : 'Enter to send · Esc to dismiss')}
        </span>
        {phase === 'idle' && prompt.trim().length > 0 && (
          <button
            type="button"
            onClick={handleSubmit}
            style={{
              background: '#4B5AFF',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '3px 10px',
              fontSize: 11,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

export default CursorBubbleView;
