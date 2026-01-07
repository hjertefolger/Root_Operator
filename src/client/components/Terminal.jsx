import { useRef, useEffect, useCallback, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import VirtualKeyboard from './VirtualKeyboard';

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const { terminal, isReady, write, sendSpecial } = useTerminal(
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

  // Toggle keyboard on terminal tap
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
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-black"
        style={{ padding: '8px 12px' }}
        onClick={handleContainerClick}
      />

      {/* Animated Virtual Keyboard */}
      <div className={`vkb-container ${showKeyboard ? 'visible' : ''}`}>
        <VirtualKeyboard
          onInput={handleInput}
          onSpecialKey={handleSpecialKey}
          onPaste={handlePaste}
        />
      </div>
    </div>
  );
}

export default Terminal;
