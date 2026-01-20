import { useState, useCallback, useRef, memo, useEffect } from 'react';
import Keyboard from 'react-simple-keyboard';
import {
  Delete,
  CornerDownLeft,
  ChevronUp,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Globe,
  KeyboardOff
} from 'lucide-react';

// Calculate modifier code for escape sequences
// 1=none, 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl, 6=Ctrl+Shift, 7=Ctrl+Alt, 8=Ctrl+Shift+Alt
function getModifierCode(shift, alt, ctrl) {
  let code = 1;
  if (shift) code += 1;
  if (alt) code += 2;
  if (ctrl) code += 4;
  return code;
}

function VirtualKeyboard({ onInput, onSpecialKey, onPaste }) {
  const [layoutName, setLayoutName] = useState('default');
  const [shiftActive, setShiftActive] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [cmdActive, setCmdActive] = useState(false);

  // Send a special key with modifiers applied
  const sendSpecialWithModifiers = useCallback((baseSeq, keyCode) => {
    const mod = getModifierCode(shiftActive, altActive || cmdActive, ctrlActive);
    if (mod === 1) {
      // No modifiers - send base sequence
      onSpecialKey?.(baseSeq);
    } else {
      // With modifiers - send CSI 1;{mod}{keyCode} format
      onSpecialKey?.(`\x1b[1;${mod}${keyCode}`);
    }
  }, [shiftActive, altActive, cmdActive, ctrlActive, onSpecialKey]);

  const handleKeyPress = useCallback((button) => {
    if (button === '{numbers}') { setLayoutName('numbers'); return; }
    if (button === '{symbols}') { setLayoutName('symbols'); return; }
    if (button === '{abc}') { setLayoutName('default'); return; }
    if (button === '{shift}') {
      setLayoutName(prev => prev === 'default' ? 'shift' : 'default');
      setShiftActive(prev => !prev);
      return;
    }
    if (button === '{ctrl}') { setCtrlActive(prev => !prev); return; }
    if (button === '{enter}') { onSpecialKey?.('\r'); return; }
    if (button === '{bksp}') { onSpecialKey?.('\x7f'); return; }
    if (button === '{space}') { onInput?.(' '); return; }

    let char = button;

    // Apply Ctrl modifier (converts a-z to control characters)
    if (ctrlActive && char.length === 1) {
      const lower = char.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        char = String.fromCharCode(lower.charCodeAt(0) - 96);
        onInput?.(char);
        return;
      }
    }

    // Apply Alt/Cmd modifier (sends ESC prefix)
    if ((altActive || cmdActive) && char.length === 1) {
      onSpecialKey?.('\x1b' + char);
    } else {
      onInput?.(char);
    }

    // Reset shift after typing (like real keyboard)
    if (layoutName === 'shift') {
      setLayoutName('default');
      setShiftActive(false);
    }
  }, [onInput, onSpecialKey, ctrlActive, altActive, cmdActive, layoutName]);

  // Handle tab with modifiers (Shift+Tab = reverse tab)
  const handleTab = useCallback(() => {
    if (shiftActive) {
      onSpecialKey?.('\x1b[Z'); // Shift+Tab (reverse tab / backtab)
    } else {
      onSpecialKey?.('\x09'); // Regular tab
    }
  }, [shiftActive, onSpecialKey]);

  // Track touched button for immediate visual feedback
  const touchedRef = useRef(null);

  // Ref for keyboard container to add direct touch handling
  const keyboardContainerRef = useRef(null);

  // Direct touch event delegation for reliable key registration
  // Bypasses react-simple-keyboard's touch handling which can miss events on iOS
  useEffect(() => {
    const container = keyboardContainerRef.current;
    if (!container) return;

    const handleTouchStart = (e) => {
      // Find the button element (might be the target or an ancestor)
      const button = e.target.closest('.hg-button');
      if (!button) return;

      // Get the key value from data attribute
      const key = button.getAttribute('data-skbtn');
      if (!key) return;

      // Prevent default to stop react-simple-keyboard from also handling
      e.preventDefault();

      // Visual feedback
      button.classList.add('hg-activeButton');

      // Fire the key press
      handleKeyPress(key);
    };

    const handleTouchEnd = (e) => {
      // Clear visual feedback from all buttons
      container.querySelectorAll('.hg-activeButton').forEach(btn => {
        btn.classList.remove('hg-activeButton');
      });
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleKeyPress]);

  // Touch handler for toolbar buttons - fires on touchstart for instant response
  const handleTouch = useCallback((action) => (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('touching');
    touchedRef.current = e.currentTarget;
    action();
  }, []);

  // Clear touch feedback
  const handleTouchEnd = useCallback(() => {
    if (touchedRef.current) {
      touchedRef.current.classList.remove('touching');
      touchedRef.current = null;
    }
  }, []);

  return (
    <div className="vkb">
      {/* Terminal toolbar row */}
      <div className="vkb-toolbar" onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}>
        <button onTouchStart={handleTouch(() => onSpecialKey?.('\x1b'))}>esc</button>
        <button onTouchStart={handleTouch(handleTab)}>tab</button>
        <button className={ctrlActive ? 'active' : ''} onTouchStart={handleTouch(() => setCtrlActive(p => !p))}>ctrl</button>
        <button className={altActive ? 'active' : ''} onTouchStart={handleTouch(() => setAltActive(p => !p))}>alt</button>
        <button className={cmdActive ? 'active' : ''} onTouchStart={handleTouch(() => setCmdActive(p => !p))}>cmd</button>
        <button onTouchStart={handleTouch(() => sendSpecialWithModifiers('\x1b[A', 'A'))}><ArrowUp size={16} /></button>
        <button onTouchStart={handleTouch(() => sendSpecialWithModifiers('\x1b[B', 'B'))}><ArrowDown size={16} /></button>
        <button onTouchStart={handleTouch(() => sendSpecialWithModifiers('\x1b[D', 'D'))}><ArrowLeft size={16} /></button>
        <button onTouchStart={handleTouch(() => sendSpecialWithModifiers('\x1b[C', 'C'))}><ArrowRight size={16} /></button>
        <button onMouseDown={e => { e.preventDefault(); onPaste?.(); }}><Clipboard size={16} /></button>
      </div>

      {/* Main keyboard - wrapped for direct touch event handling */}
      <div ref={keyboardContainerRef}>
        <Keyboard
          layout={{
          default: [
            'q w e r t y u i o p',
            'a s d f g h j k l',
            '{shift} z x c v b n m {bksp}',
            '{numbers} {space} {enter}'
          ],
          shift: [
            'Q W E R T Y U I O P',
            'A S D F G H J K L',
            '{shift} Z X C V B N M {bksp}',
            '{numbers} {space} {enter}'
          ],
          numbers: [
            '1 2 3 4 5 6 7 8 9 0',
            '- / : ; ( ) $ & @ "',
            '{symbols} . , ? ! \' {bksp}',
            '{abc} {space} {enter}'
          ],
          symbols: [
            '[ ] { } # % ^ * + =',
            '_ \\ | ~ < > € £ ¥ ·',
            '{numbers} . , ? ! \' {bksp}',
            '{abc} {space} {enter}'
          ]
        }}
        layoutName={layoutName}
        display={{
          '{enter}': 'return',
          '{bksp}': '⌫',
          '{shift}': '⇧',
          '{space}': 'space',
          '{numbers}': '123',
          '{abc}': 'ABC',
          '{symbols}': '#+=',
        }}
        onKeyPress={handleKeyPress}
        useTouchEvents={true}
        preventMouseDownDefault={true}
        stopMouseDownPropagation={true}
          physicalKeyboardHighlight={false}
        />
      </div>
    </div>
  );
}

export default memo(VirtualKeyboard);
