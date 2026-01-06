import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  ChevronRight,
  Clipboard
} from 'lucide-react';

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const [modifierState, setModifierState] = useState({ ctrl: false, shift: false });
  const [toolbarBottom, setToolbarBottom] = useState(12);
  const lastKeyboardHeight = useRef(0);

  // Track keyboard height to position toolbar above it
  useEffect(() => {
    if (!window.visualViewport) return;

    const updateToolbarPosition = () => {
      const viewport = window.visualViewport;
      const windowHeight = window.innerHeight;
      const viewportHeight = viewport.height;
      const keyboardHeight = Math.max(0, windowHeight - viewportHeight - viewport.offsetTop);

      // Only update if keyboard height actually changed (avoid unnecessary re-renders)
      if (Math.abs(keyboardHeight - lastKeyboardHeight.current) > 10) {
        lastKeyboardHeight.current = keyboardHeight;
        setToolbarBottom(keyboardHeight > 50 ? keyboardHeight + 8 : 12);
      }
    };

    // Use requestAnimationFrame for smooth updates
    const handleViewportChange = () => {
      requestAnimationFrame(updateToolbarPosition);
    };

    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);

    // Also listen for focus/blur as backup for keyboard detection
    const handleFocus = () => setTimeout(handleViewportChange, 100);
    const handleBlur = () => {
      // When blurring, keyboard is closing - reset to bottom after short delay
      setTimeout(() => {
        lastKeyboardHeight.current = 0;
        setToolbarBottom(12);
      }, 50);
    };

    document.addEventListener('focusin', handleFocus);
    document.addEventListener('focusout', handleBlur);

    return () => {
      window.visualViewport.removeEventListener('resize', handleViewportChange);
      window.visualViewport.removeEventListener('scroll', handleViewportChange);
      document.removeEventListener('focusin', handleFocus);
      document.removeEventListener('focusout', handleBlur);
    };
  }, []);

  // Callback for when modifiers auto-release (e.g., after Ctrl+C)
  const handleModifierChange = useCallback((state) => {
    setModifierState(state);
  }, []);

  const { terminal, isReady, write, sendSpecial } = useTerminal(
    containerRef,
    socket,
    encryptInput,
    e2eReady,
    ctrlRef,
    shiftRef,
    handleModifierChange
  );

  // Handle incoming messages from server
  useEffect(() => {
    if (!socket) return;

    const handleMessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // E2E encrypted output ONLY - no unencrypted fallback
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext !== null) {
          write(plaintext);
        }
      }
      // NOTE: Unencrypted 'output' handler removed for security
      // Server buffers output until E2E is ready, then sends encrypted
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, decryptOutput, write]);

  // Focus terminal on tap (container handles this since canvas has pointer-events: none)
  const handleContainerClick = useCallback(() => {
    if (terminal) {
      terminal.focus();
    }
  }, [terminal]);

  // Handle paste from clipboard
  const handlePaste = async () => {
    if (!terminal) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        // Send pasted text through the encrypted channel
        sendSpecial(text);
      }
    } catch (err) {
      console.log('[TERMINAL] Paste failed:', err);
    }
    terminal.focus();
  };

  // Handle toolbar button clicks
  const handleToolbarClick = useCallback((key) => {
    if (!terminal) return;

    switch (key) {
      case 'esc':
        sendSpecial('\x1b');
        break;
      case 'tab':
        sendSpecial('\x09');
        break;
      case 'shift':
        shiftRef.current = !shiftRef.current;
        setModifierState(s => ({ ...s, shift: shiftRef.current }));
        break;
      case 'ctrl':
        ctrlRef.current = !ctrlRef.current;
        setModifierState(s => ({ ...s, ctrl: ctrlRef.current }));
        break;
      case 'up':
        sendSpecial('\x1b[A');
        break;
      case 'down':
        sendSpecial('\x1b[B');
        break;
      case 'left':
        sendSpecial('\x1b[D');
        break;
      case 'right':
        sendSpecial('\x1b[C');
        break;
    }

    // Re-focus terminal after button press
    setTimeout(() => terminal?.focus(), 10);
  }, [terminal, sendSpecial]);

  return (
    <div className="h-full w-full relative">
      <div
        ref={containerRef}
        className="absolute inset-0 pb-14 terminal-container"
        onClick={handleContainerClick}
      />

      {/* Floating toolbar for mobile */}
      <div
        className="toolbar fixed left-3 right-3 bg-[#1c1c1e]/90 backdrop-blur-sm rounded-full px-3 py-1 flex gap-0 justify-around items-center shadow-lg border border-white/10"
        style={{ bottom: `${toolbarBottom}px` }}
      >
        <ToolbarButton
          icon={<CornerDownLeft size={14} />}
          onClick={() => handleToolbarClick('esc')}
        />
        <ToolbarButton
          icon={<ChevronRight size={14} />}
          onClick={() => handleToolbarClick('tab')}
        />
        <ToolbarButton
          label="⇧"
          active={modifierState.shift}
          onClick={() => handleToolbarClick('shift')}
        />
        <ToolbarButton
          label="^"
          active={modifierState.ctrl}
          onClick={() => handleToolbarClick('ctrl')}
        />
        <ToolbarButton
          icon={<Clipboard size={14} />}
          onClick={handlePaste}
        />
        <div className="w-px h-4 bg-white/10" />
        <ToolbarButton
          icon={<ArrowUp size={14} />}
          onClick={() => handleToolbarClick('up')}
        />
        <ToolbarButton
          icon={<ArrowDown size={14} />}
          onClick={() => handleToolbarClick('down')}
        />
        <ToolbarButton
          icon={<ArrowLeft size={14} />}
          onClick={() => handleToolbarClick('left')}
        />
        <ToolbarButton
          icon={<ArrowRight size={14} />}
          onClick={() => handleToolbarClick('right')}
        />
      </div>
    </div>
  );
}

const ToolbarButton = memo(function ToolbarButton({ icon, label, active, onClick }) {
  return (
    <button
      // Prevent blur/focus loss when tapping buttons
      onTouchStart={(e) => {
        e.preventDefault();
      }}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`
        w-7 h-7 flex items-center justify-center rounded-md text-xs font-medium select-none
        ${active
          ? 'text-[#007AFF]'
          : 'text-gray-400 active:text-white'
        }
      `}
    >
      {icon || label}
    </button>
  );
});

export default Terminal;
