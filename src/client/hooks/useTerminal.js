import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

export function useTerminal(containerRef, socket, encryptInput, e2eReady, ctrlRef, shiftRef, onModifierChange) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(socket);
  const outputQueueRef = useRef([]);
  const [isReady, setIsReady] = useState(false);

  // Keep socket ref updated
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  // Initialize terminal - only depends on containerRef, NOT socket
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: '#000',
        foreground: '#fff',
        cursor: '#888',
        selectionBackground: '#333'
      },
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      scrollback: 5000,
      // Mobile optimizations
      rendererType: 'dom', // DOM renderer handles touch scrolling better than canvas
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Helper to sync terminal size with backend
    const syncSize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows
        }));
      }
    };

    // Fit terminal after a short delay
    setTimeout(() => {
      syncSize();
      term.focus();

      // Flush output queue
      while (outputQueueRef.current.length > 0) {
        term.write(outputQueueRef.current.shift());
      }

      setIsReady(true);
    }, 100);

    // Configure textarea for terminal input
    function refineTextarea() {
      const textarea = containerRef.current?.querySelector('.xterm-helper-textarea');
      if (textarea) {
        textarea.setAttribute('autocomplete', 'off');
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocapitalize', 'none');
        textarea.setAttribute('spellcheck', 'false');
        // Disable predictive text and suggestions to minimize accessory bar
        textarea.setAttribute('data-gramm', 'false');
        textarea.setAttribute('data-gramm_editor', 'false');
        textarea.setAttribute('data-enable-grammarly', 'false');
      }
    }

    // Run once immediately, then periodically in case xterm recreates textarea
    refineTextarea();
    const intervalId = setInterval(refineTextarea, 2000);

    // Mobile: Force focus on touch to bring up keyboard
    const handleTouch = () => {
      term.focus();
    };
    containerRef.current.addEventListener('touchstart', handleTouch, { passive: true });

    // Handle Visual Viewport for mobile keyboards - simplified to avoid flickering
    let lastHeight = 0;
    const handleViewportResize = () => {
      if (!containerRef.current || !window.visualViewport) return;

      const toolbarHeight = 48;
      const newHeight = Math.floor(window.visualViewport.height - toolbarHeight);

      // Only resize if height changed significantly (avoid micro-adjustments)
      if (Math.abs(newHeight - lastHeight) > 20) {
        lastHeight = newHeight;
        containerRef.current.style.height = `${newHeight}px`;
        window.scrollTo(0, 0);
        // Delay fit and sync to let CSS settle
        setTimeout(syncSize, 50);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportResize);
    }

    // Store container for cleanup
    const container = containerRef.current;

    // Cleanup - only when component unmounts, not on socket change
    return () => {
      clearInterval(intervalId);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportResize);
      }
      if (container) {
        container.removeEventListener('touchstart', handleTouch);
      }
      term.dispose();
      termRef.current = null;
    };
  }, [containerRef]); // Removed socket from dependencies!

  // Handle input from terminal - use refs to avoid stale closures
  useEffect(() => {
    if (!termRef.current) return;

    const term = termRef.current;

    const handleData = async (data) => {
      // Use refs for current values to avoid stale closures on reconnect
      const currentSocket = socketRef.current;

      // Block ALL input until E2E is ready and socket is open
      if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
        console.log('[TERMINAL] Ignoring input - socket not ready');
        return;
      }

      if (!e2eReady || !encryptInput) {
        console.log('[TERMINAL] Ignoring input - E2E not ready');
        return;
      }

      // Apply modifier keys from toolbar
      let modifiedData = data;
      if (ctrlRef?.current && data.length === 1) {
        const char = data.toLowerCase();
        if (char >= 'a' && char <= 'z') {
          // Convert to control character (Ctrl+A = 0x01, Ctrl+B = 0x02, etc.)
          modifiedData = String.fromCharCode(char.charCodeAt(0) - 96);
          // Ctrl stays active (sticky) - user must tap ^ again to release
        }
      }

      const encrypted = await encryptInput(modifiedData);
      if (encrypted && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'e2e_input',
          ...encrypted
        }));
      }
    };

    const disposable = term.onData(handleData);
    return () => disposable.dispose();
  }, [encryptInput, e2eReady, ctrlRef, shiftRef, onModifierChange]);

  // Handle window resize
  useEffect(() => {
    if (!fitAddonRef.current) return;

    const handleResize = () => {
      fitAddonRef.current.fit();
      // Use proposeDimensions for accurate frontend/backend sync
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows
        }));
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []); // No dependencies - uses refs

  // Write to terminal
  const write = (data) => {
    if (termRef.current) {
      termRef.current.write(data);
      // Always scroll to bottom on new output
      termRef.current.scrollToBottom();
    } else {
      outputQueueRef.current.push(data);
    }
  };

  // Send special input - only when E2E is ready
  const sendSpecial = async (data) => {
    // Block ALL input until E2E is ready - no unencrypted fallback
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !e2eReady || !encryptInput) return;

    const encrypted = await encryptInput(data);
    if (encrypted) {
      socketRef.current.send(JSON.stringify({
        type: 'e2e_input',
        ...encrypted
      }));
    }
  };

  return {
    terminal: termRef.current,
    isReady,
    write,
    sendSpecial
  };
}
