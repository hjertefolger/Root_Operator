import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { useTerminalPersistence } from './useTerminalPersistence';

function applyToolbarModifiers(data, ctrlRef, altRef, cmdRef) {
  let modifiedData = data;

  if (ctrlRef?.current && data.length === 1) {
    const char = data.toLowerCase();
    if (char >= 'a' && char <= 'z') {
      modifiedData = String.fromCharCode(char.charCodeAt(0) - 96);
    }
  }

  if ((altRef?.current || cmdRef?.current) && modifiedData.length > 0) {
    modifiedData = `\x1b${modifiedData}`;
  }

  return modifiedData;
}

export function useTerminal(containerRef, socket, encryptInput, e2eReady, ctrlRef, altRef, cmdRef) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(socket);
  const outputQueueRef = useRef([]);

  // Write batching for mobile performance (reduces render storm from rapid output)
  const writeBufferRef = useRef('');
  const rafIdRef = useRef(null);
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
        if (isMobile) {
          textarea.setAttribute('inputmode', 'none');
          textarea.setAttribute('tabindex', '-1');
          textarea.setAttribute('aria-hidden', 'true');
        } else {
          textarea.removeAttribute('inputmode');
          textarea.removeAttribute('tabindex');
          textarea.removeAttribute('aria-hidden');
        }
      }

      // Helper to sync terminal size with backend
      const syncSize = () => {
        if (!fitAddon || cancelled) return;
        try {
          const isPinnedToBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
          fitAddon.fit();
          if (isPinnedToBottom) {
            term.scrollToBottom();
          }
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
        if (!isMobile) {
          term.focus();
        }

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

      if (!isMobile) {
        handleTouch = () => {
          term.focus();
        };
        containerRef.current.addEventListener('touchstart', handleTouch, { passive: true });
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(initFrame);
      // Cancel any pending write batch
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
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

  // Send resize when E2E becomes ready (initial connect or reconnect)
  useEffect(() => {
    if (!e2eReady || !fitAddonRef.current || !socketRef.current) return;
    if (socketRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const term = termRef.current;
      const isPinnedToBottom = !term || term.buffer.active.viewportY >= term.buffer.active.baseY;
      fitAddonRef.current.fit();
      if (isPinnedToBottom && term) {
        term.scrollToBottom();
      }
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims) {
        socketRef.current.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows
        }));
      }
    } catch (e) {}
  }, [e2eReady]);

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

      const modifiedData = applyToolbarModifiers(data, ctrlRef, altRef, cmdRef);

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
  }, [isReady, socket, encryptInput, e2eReady, ctrlRef, altRef, cmdRef]);

  // Write to terminal with batching for mobile performance
  // Accumulates data and flushes once per animation frame (max 60/sec)
  // This prevents render storm from rapid PTY output (e.g., Claude Code streaming)
  const write = useCallback((data) => {
    if (!termRef.current) {
      outputQueueRef.current.push(data);
      return;
    }

    // Accumulate data in buffer
    writeBufferRef.current += data;

    // Schedule flush if not already scheduled
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;

        if (termRef.current && writeBufferRef.current) {
          const buffered = writeBufferRef.current;
          writeBufferRef.current = '';

          // Single batched write + scroll
          termRef.current.write(buffered);
          termRef.current.scrollToBottom();

          // Track content for persistence
          contentBufferRef.current += buffered;
          // Limit buffer size to 1MB
          if (contentBufferRef.current.length > 1024 * 1024) {
            contentBufferRef.current = contentBufferRef.current.slice(-1024 * 1024);
          }
          saveContent(contentBufferRef.current);
        }
      });
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

  const sendInput = useCallback(async (data) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !e2eReady || !encryptInput) {
      return;
    }

    const modifiedData = applyToolbarModifiers(data, ctrlRef, altRef, cmdRef);
    const encrypted = await encryptInput(modifiedData);
    if (encrypted) {
      socketRef.current.send(JSON.stringify({
        type: 'e2e_input',
        ...encrypted
      }));
    }
  }, [e2eReady, encryptInput, ctrlRef, altRef, cmdRef]);

  // Refit terminal to container
  const refit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        const isPinnedToBottom = termRef.current.buffer.active.viewportY >= termRef.current.buffer.active.baseY;
        fitAddonRef.current.fit();
        if (isPinnedToBottom) {
          termRef.current.scrollToBottom();
        }
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
    sendInput,
    sendSpecial,
    refit
  };
}
