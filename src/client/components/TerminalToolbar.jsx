import { memo, useCallback } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clipboard } from 'lucide-react';

function getModifierCode(ctrlActive, altActive, cmdActive) {
  let code = 1;
  if (altActive || cmdActive) code += 2;
  if (ctrlActive) code += 4;
  return code;
}

function TerminalToolbar({
  terminal,
  inputProxyRef,
  onProxyChange,
  onProxyKeyDown,
  onProxyPaste,
  onSpecialKey,
  onPaste,
  ctrlActive,
  altActive,
  cmdActive,
  onToggleCtrl,
  onToggleAlt,
  onToggleCmd,
}) {
  const refocusInput = useCallback(() => {
    if (inputProxyRef?.current) {
      inputProxyRef.current.focus();
      inputProxyRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }

    terminal?.focus();
  }, [inputProxyRef, terminal]);

  const handlePointerDown = useCallback((action) => (event) => {
    event.preventDefault();
    action();
    refocusInput();
  }, [refocusInput]);

  const sendArrowKey = useCallback((baseSeq, keyCode) => {
    const modifierCode = getModifierCode(ctrlActive, altActive, cmdActive);
    if (modifierCode === 1) {
      onSpecialKey(baseSeq);
      return;
    }

    onSpecialKey(`\x1b[1;${modifierCode}${keyCode}`);
  }, [ctrlActive, altActive, cmdActive, onSpecialKey]);

  return (
    <div className="terminal-toolbar-shell">
      <div className="terminal-toolbar-pill" role="toolbar" aria-label="Terminal special keys">
        <textarea
          ref={inputProxyRef}
          className="terminal-input-proxy"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          rows={1}
          aria-label="Terminal keyboard input"
          onChange={onProxyChange}
          onKeyDown={onProxyKeyDown}
          onPaste={onProxyPaste}
        />

        <button
          type="button"
          className="terminal-toolbar-button terminal-toolbar-button--keycap"
          aria-label="Escape"
          onPointerDown={handlePointerDown(() => onSpecialKey('\x1b'))}
        >
          ⎋
        </button>

        <button
          type="button"
          className="terminal-toolbar-button terminal-toolbar-button--keycap"
          aria-label="Tab"
          onPointerDown={handlePointerDown(() => onSpecialKey('\x09'))}
        >
          ⇥
        </button>

        <button
          type="button"
          className={`terminal-toolbar-button terminal-toolbar-button--keycap ${ctrlActive ? 'is-active' : ''}`}
          aria-label="Control"
          aria-pressed={ctrlActive}
          onPointerDown={handlePointerDown(onToggleCtrl)}
        >
          ⌃
        </button>

        <button
          type="button"
          className={`terminal-toolbar-button terminal-toolbar-button--keycap ${altActive ? 'is-active' : ''}`}
          aria-label="Alternate"
          aria-pressed={altActive}
          onPointerDown={handlePointerDown(onToggleAlt)}
        >
          ⌥
        </button>

        <button
          type="button"
          className={`terminal-toolbar-button terminal-toolbar-button--keycap ${cmdActive ? 'is-active' : ''}`}
          aria-label="Command"
          aria-pressed={cmdActive}
          onPointerDown={handlePointerDown(onToggleCmd)}
        >
          ⌘
        </button>

        <button
          type="button"
          className="terminal-toolbar-button"
          aria-label="Arrow up"
          onPointerDown={handlePointerDown(() => sendArrowKey('\x1b[A', 'A'))}
        >
          <ArrowUp size={16} strokeWidth={2} />
        </button>

        <button
          type="button"
          className="terminal-toolbar-button"
          aria-label="Arrow down"
          onPointerDown={handlePointerDown(() => sendArrowKey('\x1b[B', 'B'))}
        >
          <ArrowDown size={16} strokeWidth={2} />
        </button>

        <button
          type="button"
          className="terminal-toolbar-button"
          aria-label="Arrow left"
          onPointerDown={handlePointerDown(() => sendArrowKey('\x1b[D', 'D'))}
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>

        <button
          type="button"
          className="terminal-toolbar-button"
          aria-label="Arrow right"
          onPointerDown={handlePointerDown(() => sendArrowKey('\x1b[C', 'C'))}
        >
          <ArrowRight size={16} strokeWidth={2} />
        </button>

        <button
          type="button"
          className="terminal-toolbar-button"
          aria-label="Paste"
          onPointerDown={handlePointerDown(onPaste)}
        >
          <Clipboard size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export default memo(TerminalToolbar);
