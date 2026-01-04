import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

export function useTerminal(containerRef, socket, encryptInput, e2eReady) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const outputQueueRef = useRef([]);
  const [isReady, setIsReady] = useState(false);

  // Initialize terminal
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
      fontFamily: 'Menlo, Monaco, "Courier New", monospace'
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit terminal after a short delay
    setTimeout(() => {
      fitAddon.fit();
      if (socket) {
        socket.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
      term.focus();

      // Flush output queue
      while (outputQueueRef.current.length > 0) {
        term.write(outputQueueRef.current.shift());
      }

      setIsReady(true);
    }, 100);

    // Suppress iOS keyboard accessory bar
    function refineTextarea() {
      const textarea = containerRef.current?.querySelector('.xterm-helper-textarea');
      if (textarea) {
        textarea.setAttribute('autocomplete', 'off');
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('spellcheck', 'false');
        textarea.setAttribute('inputmode', 'email');
        textarea.setAttribute('enterkeyhint', 'send');
      }
    }

    const intervalId = setInterval(refineTextarea, 1000);

    // Handle Visual Viewport for mobile keyboards
    const handleViewportResize = () => {
      if (containerRef.current && window.visualViewport) {
        containerRef.current.style.height = `${window.visualViewport.height}px`;
        window.scrollTo(0, 0);
        fitAddon.fit();
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportResize);
    }

    // Cleanup
    return () => {
      clearInterval(intervalId);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportResize);
      }
      term.dispose();
      termRef.current = null;
    };
  }, [containerRef, socket]);

  // Handle input from terminal
  useEffect(() => {
    if (!termRef.current || !socket) return;

    const term = termRef.current;

    const handleData = async (data) => {
      if (e2eReady && encryptInput) {
        const encrypted = await encryptInput(data);
        if (encrypted) {
          socket.send(JSON.stringify({
            type: 'e2e_input',
            ...encrypted
          }));
        }
      } else {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    };

    const disposable = term.onData(handleData);
    return () => disposable.dispose();
  }, [socket, encryptInput, e2eReady]);

  // Handle window resize
  useEffect(() => {
    if (!fitAddonRef.current || !socket) return;

    const handleResize = () => {
      fitAddonRef.current.fit();
      const term = termRef.current;
      if (term) {
        socket.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [socket]);

  // Write to terminal
  const write = (data) => {
    if (termRef.current) {
      termRef.current.write(data);
    } else {
      outputQueueRef.current.push(data);
    }
  };

  // Send special input
  const sendSpecial = async (data) => {
    if (!socket) return;

    if (e2eReady && encryptInput) {
      const encrypted = await encryptInput(data);
      if (encrypted) {
        socket.send(JSON.stringify({
          type: 'e2e_input',
          ...encrypted
        }));
      }
    } else {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  };

  return {
    terminal: termRef.current,
    isReady,
    write,
    sendSpecial
  };
}
