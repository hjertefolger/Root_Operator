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

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    let term = null;
    let fitAddon = null;
    let cancelled = false;
    let handleResize = null;
    let handleViewportResize = null;
    let handleTouch = null;
    const container = containerRef.current;

    // Defer terminal creation to ensure container has valid dimensions
    const initFrame = requestAnimationFrame(() => {
      if (cancelled || !containerRef.current) return;

      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        theme: {
          background: '#000000',
          foreground: '#ffffff',
          cursor: '#ffffff',
          selectionBackground: 'rgba(255, 255, 255, 0.3)',
        },
        fontSize: isMobile ? 16 : 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 5000,
        convertEol: true,
      });

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(containerRef.current);

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Configure textarea once (disable autocorrect, etc.)
      const textarea = containerRef.current.querySelector('.xterm-helper-textarea');
      if (textarea) {
        textarea.setAttribute('autocomplete', 'off');
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('spellcheck', 'false');
        textarea.setAttribute('inputmode', 'text');
      }

      // Helper to sync terminal size with backend
      const syncSize = () => {
        if (!fitAddon || cancelled) return;
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims && socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              type: 'resize',
              cols: dims.cols,
              rows: dims.rows
            }));
          }
        } catch (e) {
          // Ignore fit errors during initialization
        }
      };

      // Initial fit after another frame to ensure xterm renderer is ready
      requestAnimationFrame(() => {
        if (cancelled) return;
        syncSize();
        term.focus();

        // Flush output queue
        while (outputQueueRef.current.length > 0) {
          term.write(outputQueueRef.current.shift());
        }

        setIsReady(true);
      });

      // Handle window resize
      handleResize = () => {
        requestAnimationFrame(syncSize);
      };

      // iOS keyboard handling - only listen to resize, not scroll (scroll causes keyboard jumping)
      handleViewportResize = () => {
        requestAnimationFrame(syncSize);
      };

      window.addEventListener('resize', handleResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleViewportResize);
      }

      // Mobile: Focus on touch to bring up keyboard
      handleTouch = () => {
        term.focus();
      };
      containerRef.current.addEventListener('touchstart', handleTouch, { passive: true });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(initFrame);
      if (handleResize) {
        window.removeEventListener('resize', handleResize);
      }
      if (window.visualViewport && handleViewportResize) {
        window.visualViewport.removeEventListener('resize', handleViewportResize);
      }
      if (handleTouch && container) {
        container.removeEventListener('touchstart', handleTouch);
      }
      if (term) {
        term.dispose();
      }
      termRef.current = null;
    };
  }, [containerRef]);

  // Handle input from terminal
  // Note: isReady dependency ensures this re-runs after terminal is created
  useEffect(() => {
    if (!termRef.current || !isReady) return;

    const term = termRef.current;

    const handleData = async (data) => {
      const currentSocket = socketRef.current;

      // Block ALL input until E2E is ready and socket is open
      if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!e2eReady || !encryptInput) {
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
  }, [isReady, encryptInput, e2eReady, ctrlRef, shiftRef, onModifierChange]);

  // Write to terminal
  const write = useCallback((data) => {
    if (termRef.current) {
      termRef.current.write(data);
      termRef.current.scrollToBottom();
    } else {
      outputQueueRef.current.push(data);
    }
  }, []);

  // Send special input (toolbar buttons)
  const sendSpecial = useCallback(async (data) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !e2eReady || !encryptInput) {
      return;
    }

    const encrypted = await encryptInput(data);
    if (encrypted) {
      socketRef.current.send(JSON.stringify({
        type: 'e2e_input',
        ...encrypted
      }));
    }
  }, [e2eReady, encryptInput]);

  return {
    terminal: termRef.current,
    isReady,
    write,
    sendSpecial
  };
}
