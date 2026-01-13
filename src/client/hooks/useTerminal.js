import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { useTerminalPersistence } from './useTerminalPersistence';

export function useTerminal(containerRef, socket, encryptInput, e2eReady, ctrlRef, shiftRef, onModifierChange) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(socket);
  const outputQueueRef = useRef([]);
  const [isReady, setIsReady] = useState(false);

  // Content tracking for persistence
  const contentBufferRef = useRef('');
  const hasReceivedServerBufferRef = useRef(false);
  const hasRestoredFromStorageRef = useRef(false);

  // Persistence hook
  const { saveContent, loadContent, markServerBufferReceived } = useTerminalPersistence();

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

      // Configure textarea
      const textarea = containerRef.current.querySelector('.xterm-helper-textarea');
      if (textarea) {
        textarea.setAttribute('autocomplete', 'off');
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('spellcheck', 'false');
        // On mobile: suppress native keyboard, use custom VirtualKeyboard instead
        // On desktop: allow native keyboard input
        if (isMobile) {
          textarea.setAttribute('inputmode', 'none');
        }
      }

      // Helper to sync terminal size with backend
      const syncSize = () => {
        if (!fitAddon || cancelled) return;
        try {
          fitAddon.fit();
          term.scrollToBottom();
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

        // Restore from sessionStorage on page reload (only if no server buffer yet)
        // This handles the case where user reloads the page
        if (!hasReceivedServerBufferRef.current && !hasRestoredFromStorageRef.current) {
          const storedContent = loadContent();
          if (storedContent) {
            console.log('[Terminal] Restoring content from sessionStorage');
            hasRestoredFromStorageRef.current = true;
            contentBufferRef.current = storedContent;
            term.write(storedContent);
            term.scrollToBottom();
          }
        }

        setIsReady(true);
      });

      // ResizeObserver for smooth auto-refit when container size changes
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(syncSize);
      });
      resizeObserver.observe(containerRef.current);

      // Also handle window/viewport resize
      handleResize = () => requestAnimationFrame(syncSize);
      handleViewportResize = () => requestAnimationFrame(syncSize);

      window.addEventListener('resize', handleResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleViewportResize);
      }

      // Store for cleanup
      containerRef.current._resizeObserver = resizeObserver;

      // Mobile: Focus on touch to bring up keyboard
      handleTouch = () => {
        term.focus();
      };
      containerRef.current.addEventListener('touchstart', handleTouch, { passive: true });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(initFrame);
      if (container?._resizeObserver) {
        container._resizeObserver.disconnect();
      }
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
  }, [isReady, socket, encryptInput, e2eReady, ctrlRef, shiftRef, onModifierChange]);

  // Write to terminal with content tracking for persistence
  const write = useCallback((data) => {
    if (termRef.current) {
      termRef.current.write(data);
      termRef.current.scrollToBottom();

      // Track content for persistence
      contentBufferRef.current += data;
      // Limit buffer size to 1MB
      if (contentBufferRef.current.length > 1024 * 1024) {
        contentBufferRef.current = contentBufferRef.current.slice(-1024 * 1024);
      }
      saveContent(contentBufferRef.current);
    } else {
      outputQueueRef.current.push(data);
    }
  }, [saveContent]);

  // Write server buffer (initial data on connect/reconnect)
  // Server buffer is source of truth - clears terminal and writes fresh content
  const writeServerBuffer = useCallback((data) => {
    if (!data) return;

    // Mark that we received server buffer - don't use stale sessionStorage
    hasReceivedServerBufferRef.current = true;
    markServerBufferReceived();

    // Reset content buffer to server data
    contentBufferRef.current = data;

    if (termRef.current) {
      // Clear terminal and write server buffer (prevents duplication on reconnect)
      termRef.current.clear();
      termRef.current.write(data);
      termRef.current.scrollToBottom();
      saveContent(data);
    } else {
      outputQueueRef.current.push(data);
    }
  }, [saveContent, markServerBufferReceived]);

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

  // Refit terminal to container
  const refit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        fitAddonRef.current.fit();
        termRef.current.scrollToBottom();
      } catch (e) {
        // Ignore fit errors
      }
    }
  }, []);

  return {
    terminal: termRef.current,
    isReady,
    write,
    writeServerBuffer,
    sendSpecial,
    refit
  };
}
