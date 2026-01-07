import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { Button } from '@/components/ui/button';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  ChevronRight,
  Clipboard
} from 'lucide-react';
import { cn } from '@/lib/utils';

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const [modifierState, setModifierState] = useState({ ctrl: false, shift: false });

  // Callback for when modifiers auto-release
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

      // E2E encrypted output ONLY
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext !== null) {
          write(plaintext);
        }
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, decryptOutput, write]);

  // Focus terminal on tap
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
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Terminal container - flex-1 to fill available space */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-black [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto"
        style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}
        onClick={handleContainerClick}
      />

      {/* Toolbar */}
      <div className="flex-shrink-0 h-12 flex items-center justify-around bg-zinc-900" style={{ paddingLeft: 12, paddingRight: 12 }}>
        <ToolbarButton
          icon={<CornerDownLeft size={16} />}
          onClick={() => handleToolbarClick('esc')}
          label="ESC"
        />
        <ToolbarButton
          icon={<ChevronRight size={16} />}
          onClick={() => handleToolbarClick('tab')}
          label="TAB"
        />
        <ToolbarButton
          text="⇧"
          active={modifierState.shift}
          onClick={() => handleToolbarClick('shift')}
          label="Shift"
        />
        <ToolbarButton
          text="^"
          active={modifierState.ctrl}
          onClick={() => handleToolbarClick('ctrl')}
          label="Ctrl"
        />
        <ToolbarButton
          icon={<Clipboard size={16} />}
          onClick={handlePaste}
          label="Paste"
        />

        <div className="w-px h-5 bg-white/10" />

        <ToolbarButton
          icon={<ArrowUp size={16} />}
          onClick={() => handleToolbarClick('up')}
          label="Up"
        />
        <ToolbarButton
          icon={<ArrowDown size={16} />}
          onClick={() => handleToolbarClick('down')}
          label="Down"
        />
        <ToolbarButton
          icon={<ArrowLeft size={16} />}
          onClick={() => handleToolbarClick('left')}
          label="Left"
        />
        <ToolbarButton
          icon={<ArrowRight size={16} />}
          onClick={() => handleToolbarClick('right')}
          label="Right"
        />
      </div>
    </div>
  );
}

const ToolbarButton = memo(function ToolbarButton({ icon, text, active, onClick, label }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onTouchStart={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "rounded-lg touch-manipulation",
        active && "text-[#4B5AFF] bg-[#4B5AFF]/10"
      )}
      title={label}
    >
      {icon || <span className="text-base font-medium">{text}</span>}
    </Button>
  );
});

export default Terminal;
