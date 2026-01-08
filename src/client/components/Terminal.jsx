import { useRef, useEffect, useCallback, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import VirtualKeyboard from './VirtualKeyboard';

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const { terminal, write, sendSpecial } = useTerminal(
    containerRef,
    socket,
    encryptInput,
    e2eReady,
    ctrlRef,
    shiftRef,
    null
  );

  useEffect(() => {
    if (!socket) return;
    const handleMessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext !== null) write(plaintext);
      }
    };
    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, decryptOutput, write]);

  const handleContainerClick = useCallback(() => {
    terminal?.focus();
    setShowKeyboard(prev => !prev);
  }, [terminal]);

  const handleInput = useCallback((char) => sendSpecial(char), [sendSpecial]);
  const handleSpecialKey = useCallback((seq) => sendSpecial(seq), [sendSpecial]);
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendSpecial(text);
    } catch (err) {}
  }, [sendSpecial]);

  return (
    <div className="terminal-layout">
      {/* Terminal - fluid, takes remaining space */}
      <div
        ref={containerRef}
        className="terminal-area"
        onClick={handleContainerClick}
      />

      {/* Keyboard - grid animation for smooth 0 to auto */}
      <div
        className={`keyboard-wrapper ${showKeyboard ? 'visible' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="keyboard-inner">
          <VirtualKeyboard
            onInput={handleInput}
            onSpecialKey={handleSpecialKey}
            onPaste={handlePaste}
          />
        </div>
      </div>
    </div>
  );
}

export default Terminal;
