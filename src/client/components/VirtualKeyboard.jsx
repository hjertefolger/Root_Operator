import { useState, useCallback, memo } from 'react';
import Keyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';
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

function VirtualKeyboard({ onInput, onSpecialKey, onPaste }) {
  const [layoutName, setLayoutName] = useState('default');
  const [ctrlActive, setCtrlActive] = useState(false);

  const handleKeyPress = useCallback((button) => {
    if (button === '{numbers}') { setLayoutName('numbers'); return; }
    if (button === '{abc}') { setLayoutName('default'); return; }
    if (button === '{shift}') {
      setLayoutName(prev => prev === 'default' ? 'shift' : 'default');
      return;
    }
    if (button === '{ctrl}') { setCtrlActive(prev => !prev); return; }
    if (button === '{enter}') { onSpecialKey?.('\r'); return; }
    if (button === '{bksp}') { onSpecialKey?.('\x7f'); return; }
    if (button === '{space}') { onInput?.(' '); return; }

    let char = button;
    if (ctrlActive && char.length === 1) {
      const lower = char.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        char = String.fromCharCode(lower.charCodeAt(0) - 96);
      }
    }
    onInput?.(char);
    if (layoutName === 'shift') setLayoutName('default');
  }, [onInput, onSpecialKey, ctrlActive, layoutName]);

  return (
    <div className="vkb">
      {/* Terminal toolbar row */}
      <div className="vkb-toolbar">
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x1b'); }}>esc</button>
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x09'); }}>tab</button>
        <button className={ctrlActive ? 'active' : ''} onMouseDown={e => { e.preventDefault(); setCtrlActive(p => !p); }}>ctrl</button>
        <div className="vkb-toolbar-sep" />
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x1b[A'); }}><ArrowUp size={16} /></button>
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x1b[B'); }}><ArrowDown size={16} /></button>
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x1b[D'); }}><ArrowLeft size={16} /></button>
        <button onMouseDown={e => { e.preventDefault(); onSpecialKey?.('\x1b[C'); }}><ArrowRight size={16} /></button>
        <div className="vkb-toolbar-sep" />
        <button onMouseDown={e => { e.preventDefault(); onPaste?.(); }}><Clipboard size={16} /></button>
      </div>

      {/* Main keyboard */}
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
            '- / : ; ( ) $ & @',
            '{symbols} . , ? ! \' {bksp}',
            '{abc} {space} {enter}'
          ],
          symbols: [
            '[ ] { } # % ^ * + =',
            '_ \\ | ~ < > ` "',
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
        preventMouseDownDefault={true}
        stopMouseDownPropagation={true}
        physicalKeyboardHighlight={false}
      />
    </div>
  );
}

export default memo(VirtualKeyboard);
