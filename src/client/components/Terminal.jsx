import { useRef, useEffect, useCallback, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import VirtualKeyboard from './VirtualKeyboard';

// Detect mobile device
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  // Track if we've received the initial server buffer after E2E ready
  const hasReceivedInitialBufferRef = useRef(false);

  const { terminal, write, writeServerBuffer, sendSpecial } = useTerminal(
    containerRef,
    socket,
    encryptInput,
    e2eReady,
    ctrlRef,
    shiftRef,
    null
  );

  // Reset initial buffer flag when E2E becomes not ready (reconnection)
  useEffect(() => {
    if (!e2eReady) {
      hasReceivedInitialBufferRef.current = false;
    }
  }, [e2eReady]);

  useEffect(() => {
    if (!socket) return;
    const handleMessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext !== null) {
          // First output after E2E ready is the server buffer
          if (!hasReceivedInitialBufferRef.current) {
            hasReceivedInitialBufferRef.current = true;
            writeServerBuffer(plaintext);
          } else {
            write(plaintext);
          }
        }
      }
    };
    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, decryptOutput, write, writeServerBuffer]);

  const handleContainerClick = useCallback(() => {
    terminal?.focus();
    // Only toggle virtual keyboard on mobile
    if (isMobile) {
      setShowKeyboard(prev => !prev);
    }
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

      {/* Keyboard - only on mobile */}
      {isMobile && (
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
      )}
    </div>
  );
}

export default Terminal;
