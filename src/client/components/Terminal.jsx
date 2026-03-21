import { useRef, useEffect, useCallback, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';

// Detect mobile device
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const inputProxyRef = useRef(null);
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  const cmdRef = useRef(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [cmdActive, setCmdActive] = useState(false);

  // Track if we've received the initial server buffer after E2E ready
  const hasReceivedInitialBufferRef = useRef(false);

  const { terminal, write, writeServerBuffer, sendInput, sendSpecial } = useTerminal(
    containerRef,
    socket,
    encryptInput,
    e2eReady,
    ctrlRef,
    altRef,
    cmdRef
  );

  useEffect(() => {
    ctrlRef.current = ctrlActive;
  }, [ctrlActive]);

  useEffect(() => {
    altRef.current = altActive;
  }, [altActive]);

  useEffect(() => {
    cmdRef.current = cmdActive;
  }, [cmdActive]);

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

  const clearInputProxy = useCallback(() => {
    if (inputProxyRef.current) {
      inputProxyRef.current.value = '';
    }
  }, []);

  const focusTerminalInput = useCallback(() => {
    if (isMobile && inputProxyRef.current) {
      inputProxyRef.current.focus();
      inputProxyRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }

    terminal?.focus();
  }, [terminal]);

  const handleContainerPointerDown = useCallback((event) => {
    if (isMobile) {
      event.preventDefault();
    }

    focusTerminalInput();
  }, [focusTerminalInput]);

  const handleContainerClick = useCallback(() => {
    if (!isMobile) {
      focusTerminalInput();
    }
  }, [focusTerminalInput]);

  const handleSpecialKey = useCallback((seq) => sendSpecial(seq), [sendSpecial]);
  const handlePaste = useCallback(async () => {
    focusTerminalInput();
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendSpecial(text);
    } catch (err) {}
  }, [focusTerminalInput, sendSpecial]);

  const handleProxyChange = useCallback((event) => {
    const value = event.currentTarget.value;
    if (!value) return;

    sendInput(value.replace(/\r?\n/g, '\r'));
    clearInputProxy();
  }, [sendInput, clearInputProxy]);

  const handleProxyKeyDown = useCallback((event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendInput('\r');
      clearInputProxy();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      handleSpecialKey('\x09');
      clearInputProxy();
      return;
    }

    if (event.key === 'Backspace' && !event.currentTarget.value) {
      event.preventDefault();
      handleSpecialKey('\x7f');
      return;
    }
  }, [sendInput, clearInputProxy, handleSpecialKey]);

  const handleProxyPaste = useCallback((event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text');
    if (text) {
      sendSpecial(text);
    }
    clearInputProxy();
  }, [sendSpecial, clearInputProxy]);

  return (
    <div className="terminal-layout">
      {/* Terminal - fluid, takes remaining space */}
      <div
        ref={containerRef}
        className="terminal-area"
        onPointerDown={handleContainerPointerDown}
        onClick={handleContainerClick}
      />

      {/* Special keys toolbar - only on mobile */}
      {isMobile && (
        <TerminalToolbar
          terminal={terminal}
          inputProxyRef={inputProxyRef}
          onProxyChange={handleProxyChange}
          onProxyKeyDown={handleProxyKeyDown}
          onProxyPaste={handleProxyPaste}
          onSpecialKey={handleSpecialKey}
          onPaste={handlePaste}
          ctrlActive={ctrlActive}
          altActive={altActive}
          cmdActive={cmdActive}
          onToggleCtrl={() => setCtrlActive(prev => !prev)}
          onToggleAlt={() => setAltActive(prev => !prev)}
          onToggleCmd={() => setCmdActive(prev => !prev)}
        />
      )}
    </div>
  );
}

export default Terminal;
