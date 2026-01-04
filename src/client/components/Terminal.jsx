import { useRef, useEffect, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';

function Terminal({ socket, encryptInput, decryptOutput, e2eReady }) {
  const containerRef = useRef(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);

  const { terminal, isReady, write, sendSpecial } = useTerminal(
    containerRef,
    socket,
    encryptInput,
    e2eReady
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

      // E2E encrypted output
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext !== null) {
          write(plaintext);
        }
      }

      // Unencrypted output (fallback during E2E setup)
      if (msg.type === 'output') {
        write(msg.data);
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, decryptOutput, write]);

  // Click to focus terminal (important for mobile)
  useEffect(() => {
    const handleClick = (e) => {
      if (!e.target.closest('.toolbar') && terminal) {
        terminal.focus();
        window.scrollTo(0, 0);
      }
    };

    document.body.addEventListener('click', handleClick);
    return () => document.body.removeEventListener('click', handleClick);
  }, [terminal]);

  // Handle toolbar button clicks
  const handleToolbarClick = (key) => {
    if (!terminal) return;

    terminal.focus();

    switch (key) {
      case 'esc':
        sendSpecial('\x1b');
        break;
      case 'tab':
        sendSpecial('\x09');
        break;
      case 'shift':
        setShiftActive(!shiftActive);
        break;
      case 'ctrl':
        setCtrlActive(!ctrlActive);
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
  };

  return (
    <div className="h-full w-full flex flex-col">
      <div ref={containerRef} className="flex-1 terminal-container" />

      {/* Toolbar for mobile */}
      <div className="toolbar bg-[#1c1c1e] border-t border-gray-800 p-2 flex gap-1 justify-around">
        <ToolbarButton label="ESC" onClick={() => handleToolbarClick('esc')} />
        <ToolbarButton label="TAB" onClick={() => handleToolbarClick('tab')} />
        <ToolbarButton
          label="SHIFT"
          active={shiftActive}
          onClick={() => handleToolbarClick('shift')}
        />
        <ToolbarButton
          label="CTRL"
          active={ctrlActive}
          onClick={() => handleToolbarClick('ctrl')}
        />
        <ToolbarButton label="↑" onClick={() => handleToolbarClick('up')} />
        <ToolbarButton label="↓" onClick={() => handleToolbarClick('down')} />
        <ToolbarButton label="←" onClick={() => handleToolbarClick('left')} />
        <ToolbarButton label="→" onClick={() => handleToolbarClick('right')} />
      </div>
    </div>
  );
}

function ToolbarButton({ label, active, onClick }) {
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`
        flex-1 px-2 py-1 rounded text-xs font-medium
        ${active
          ? 'bg-[#007AFF] text-white'
          : 'bg-[#2c2c2e] text-gray-300 active:bg-[#3a3a3c]'
        }
      `}
    >
      {label}
    </button>
  );
}

export default Terminal;
