/**
 * Cursor annotation surface.
 *
 * Mounted into a borderless fullscreen NSPanel created by
 * src/main/cursor-annotation.js. Hydrates the freeze image + display
 * geometry + initial rect + cursor anchor on mount, then hosts:
 *   - background freeze image
 *   - dim overlay outside the rectangle
 *   - rectangle: drag bottom-right grip to move, drag corners to resize
 *   - toolbar: pen/eraser, color popover, thickness popover, undo/redo,
 *     cancel, done
 *   - drawing surface (strokes only render inside the rectangle)
 *
 * Strokes are stored as vector data; erasing removes whole strokes (the
 * action history records the inverse so undo restores the right entries
 * at the right indices). Composition to PNG happens only at commit.
 *
 * On commit: composes the freeze + strokes onto an offscreen canvas at
 * native resolution, base64-encodes the PNG bytes, ships via IPC. Main
 * writes the file (renderer is sandboxed; we don't trust renderer paths).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useElectron } from '../hooks/useElectron';
import { ANNOTATION_COLORS, STROKE_WIDTHS, drawStroke } from '../../shared/annotation-constants';
import { Undo2, Redo2, Check, X, Pencil, Eraser } from 'lucide-react';

const HANDLE_SIZE = 12;
const MIN_RECT = 200;
const ERASER_RADIUS = 14; // CSS px around the cursor; whole stroke erased on hit
const TOOLBAR_OFFSET_X = 14;
const TOOLBAR_OFFSET_Y = 18;
const MOVE_TAB_W = 56;
const MOVE_TAB_H = 18;
const MOVE_TAB_GAP = 6;
// Toolbar bounding box used for clamping. Conservative — actual pill
// width depends on font/icons but the right-most buttons must stay
// onscreen. Both initial placement and drag clamp use these.
const APPROX_TOOLBAR_WIDTH = 360;
const APPROX_TOOLBAR_HEIGHT = 56;

const ACCENT = '#4B5AFF';
const PILL_BG = 'rgba(10,10,10,0.82)';
const PILL_BORDER = '1px solid rgba(255,255,255,0.08)';
const PILL_SHADOW = '0 18px 48px rgba(0,0,0,0.28)';

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function distToSegment(p, a, b) {
  const ax = a.x; const ay = a.y;
  const bx = b.x; const by = b.y;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}
function strokeHit(stroke, point, threshold) {
  if (!stroke.points || stroke.points.length === 0) return false;
  if (stroke.points.length === 1) return dist(stroke.points[0], point) <= threshold;
  for (let i = 0; i < stroke.points.length - 1; i += 1) {
    if (distToSegment(point, stroke.points[i], stroke.points[i + 1]) <= threshold) return true;
  }
  return false;
}

function CursorAnnotationView() {
  const { invoke } = useElectron();

  const [initState, setInitState] = useState(null);
  const [error, setError] = useState(null);
  const [rect, setRect] = useState(null);
  const [strokes, setStrokes] = useState([]);
  // Action history for undo/redo. Entries:
  //   { type: 'add',    stroke }
  //   { type: 'remove', stroke, index }
  // On undo: invert. On redo: replay.
  const [history, setHistory] = useState([]);
  const [redoHistory, setRedoHistory] = useState([]);

  const [color, setColor] = useState(ANNOTATION_COLORS[1].value); // Red default
  const [width, setWidth] = useState(STROKE_WIDTHS[1].value);
  const [tool, setTool] = useState('draw'); // 'draw' | 'erase'
  const [pickerOpen, setPickerOpen] = useState(null); // 'color' | 'thickness' | null

  const [drawing, setDrawing] = useState(false);
  const [toolbarPos, setToolbarPos] = useState(null); // window-local
  const [draggingToolbar, setDraggingToolbar] = useState(false);
  const dragStateRef = useRef(null);

  // Hydrate.
  useEffect(() => {
    let cancelled = false;
    invoke('CURSOR_ANNOTATION_GET_INIT_STATE').then((state) => {
      if (cancelled) return;
      if (!state || state.ok !== true) {
        setError('Could not load annotation state.');
        return;
      }
      setInitState(state);
      setRect({ ...state.rect });
      // Toolbar anchors at the cursor (window-local), with the same
      // offsets the cursor presence input pill uses. Clamped so the
      // entire pill fits onscreen.
      // Approximate dimensions used to clamp the initial toolbar
      // position. Conservative enough to keep the right-most buttons
      // (Cancel / Done) on screen at any anchor; the same constant is
      // used by the toolbar drag clamp below for consistency.
      const APPROX_TOOLBAR_W = APPROX_TOOLBAR_WIDTH;
      const APPROX_TOOLBAR_H = APPROX_TOOLBAR_HEIGHT;
      const anchor = state.cursorAnchor || { x: state.rect.x + 16, y: state.rect.y + 16 };
      const toolbarX = clamp(anchor.x + TOOLBAR_OFFSET_X, 8, state.display.width - APPROX_TOOLBAR_W - 8);
      const toolbarY = clamp(anchor.y + TOOLBAR_OFFSET_Y, 8, state.display.height - APPROX_TOOLBAR_H - 8);
      setToolbarPos({ x: toolbarX, y: toolbarY });
    }).catch((err) => {
      if (cancelled) return;
      setError(err?.message || 'Failed to load annotation state.');
    });
    return () => { cancelled = true; };
  }, [invoke]);

  // --- Actions (mutate strokes via history) -------------------------------

  const addStroke = useCallback((stroke) => {
    setStrokes((prev) => [...prev, stroke]);
    setHistory((h) => [...h, { type: 'add', stroke }]);
    setRedoHistory([]);
  }, []);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    if (last.type === 'add') {
      // Remove the most-recently-added stroke (matched by ref).
      setStrokes((s) => {
        const idx = s.lastIndexOf(last.stroke);
        if (idx < 0) return s;
        const next = s.slice();
        next.splice(idx, 1);
        return next;
      });
    } else if (last.type === 'remove') {
      // Re-insert the erased stroke at its original index.
      setStrokes((s) => {
        const next = s.slice();
        const idx = clamp(last.index, 0, next.length);
        next.splice(idx, 0, last.stroke);
        return next;
      });
    }
    setHistory((h) => h.slice(0, -1));
    setRedoHistory((r) => [...r, last]);
  }, [history]);

  const redo = useCallback(() => {
    if (redoHistory.length === 0) return;
    const last = redoHistory[redoHistory.length - 1];
    if (last.type === 'add') {
      setStrokes((s) => [...s, last.stroke]);
    } else if (last.type === 'remove') {
      setStrokes((s) => {
        const idx = s.lastIndexOf(last.stroke);
        if (idx < 0) return s;
        const next = s.slice();
        next.splice(idx, 1);
        return next;
      });
    }
    setHistory((h) => [...h, last]);
    setRedoHistory((r) => r.slice(0, -1));
  }, [redoHistory]);

  // --- Drawing / erasing handlers ----------------------------------------

  const isInsideRect = useCallback((x, y) => {
    if (!rect) return false;
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }, [rect]);

  const eraseAt = useCallback((px, py) => {
    if (!rect) return;
    const local = { x: px - rect.x, y: py - rect.y };
    // Erase whole stroke whose path comes within (ERASER_RADIUS +
    // stroke.width/2) of the eraser cursor. Test top-down so the
    // most recent stroke wins ties.
    let removeIdx = -1;
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      const threshold = ERASER_RADIUS + (strokes[i].width || 0) / 2;
      if (strokeHit(strokes[i], local, threshold)) {
        removeIdx = i;
        break;
      }
    }
    if (removeIdx === -1) return;
    const stroke = strokes[removeIdx];
    setStrokes((prev) => {
      const next = prev.slice();
      // Re-resolve the index against the current strokes array in case
      // it shifted between render and mouse event (concurrent erases
      // during a drag).
      const idx = prev.indexOf(stroke);
      if (idx < 0) return prev;
      next.splice(idx, 1);
      return next;
    });
    setHistory((h) => [...h, { type: 'remove', stroke, index: removeIdx }]);
    setRedoHistory([]);
  }, [rect, strokes]);

  const startStroke = useCallback((e) => {
    if (!rect) return;
    if (pickerOpen) {
      setPickerOpen(null);
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    if (!isInsideRect(x, y)) return;
    if (tool === 'erase') {
      eraseAt(x, y);
      setDrawing(true);
      return;
    }
    addStroke({ color, width, points: [{ x: x - rect.x, y: y - rect.y }] });
    setDrawing(true);
  }, [rect, pickerOpen, isInsideRect, tool, eraseAt, addStroke, color, width]);

  const continueStroke = useCallback((e) => {
    if (!drawing || !rect) return;
    const px = e.clientX;
    const py = e.clientY;
    if (!isInsideRect(px, py)) return;
    if (tool === 'erase') {
      eraseAt(px, py);
      return;
    }
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      // Mutate the live stroke's points array in place. The stroke
      // object identity must be preserved across the draw, because
      // the action history captured a reference to it on stroke
      // start; if we replace the object via spread, undo's
      // reference-equality lookup misses and multi-point strokes
      // become un-undoable. Returning a new array ref still triggers
      // the React re-render the preview canvas depends on.
      const last = prev[prev.length - 1];
      last.points.push({ x: px - rect.x, y: py - rect.y });
      return [...prev];
    });
  }, [drawing, rect, isInsideRect, tool, eraseAt]);

  const endStroke = useCallback(() => {
    setDrawing(false);
  }, []);

  // --- Rect drag (move + resize) -----------------------------------------

  const onRectMouseDown = useCallback((mode) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragStateRef.current = {
      mode, // 'move' | 'nw' | 'ne' | 'sw' | 'se'
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...rect },
    };
  }, [rect]);

  const onToolbarHandleDown = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    setDraggingToolbar(true);
    dragStateRef.current = {
      mode: 'toolbar',
      startX: e.clientX,
      startY: e.clientY,
      startToolbar: { ...toolbarPos },
    };
  }, [toolbarPos]);

  // Pointer-move dispatcher.
  useEffect(() => {
    const onMove = (e) => {
      const drag = dragStateRef.current;
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (drag.mode === 'toolbar') {
          if (initState) {
            setToolbarPos({
              x: clamp(drag.startToolbar.x + dx, 0, initState.display.width - APPROX_TOOLBAR_WIDTH),
              y: clamp(drag.startToolbar.y + dy, 0, initState.display.height - APPROX_TOOLBAR_HEIGHT),
            });
          }
          return;
        }
        if (!initState) return;
        const display = initState.display;
        const r0 = drag.startRect;
        let nx = r0.x;
        let ny = r0.y;
        let nw = r0.w;
        let nh = r0.h;
        if (drag.mode === 'move') {
          nx = clamp(r0.x + dx, 0, display.width - r0.w);
          ny = clamp(r0.y + dy, 0, display.height - r0.h);
        } else if (drag.mode === 'nw') {
          nx = clamp(r0.x + dx, 0, r0.x + r0.w - MIN_RECT);
          ny = clamp(r0.y + dy, 0, r0.y + r0.h - MIN_RECT);
          nw = r0.w + (r0.x - nx);
          nh = r0.h + (r0.y - ny);
        } else if (drag.mode === 'ne') {
          ny = clamp(r0.y + dy, 0, r0.y + r0.h - MIN_RECT);
          nw = clamp(r0.w + dx, MIN_RECT, display.width - r0.x);
          nh = r0.h + (r0.y - ny);
        } else if (drag.mode === 'sw') {
          nx = clamp(r0.x + dx, 0, r0.x + r0.w - MIN_RECT);
          nw = r0.w + (r0.x - nx);
          nh = clamp(r0.h + dy, MIN_RECT, display.height - r0.y);
        } else if (drag.mode === 'se') {
          nw = clamp(r0.w + dx, MIN_RECT, display.width - r0.x);
          nh = clamp(r0.h + dy, MIN_RECT, display.height - r0.y);
        }
        setRect({ x: nx, y: ny, w: nw, h: nh });
        return;
      }
      if (drawing) continueStroke(e);
    };
    const onUp = () => {
      dragStateRef.current = null;
      setDraggingToolbar(false);
      endStroke();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drawing, continueStroke, endStroke, initState]);

  // --- Keyboard ----------------------------------------------------------

  const commit = useCallback(async () => {
    if (!initState || !rect) return;
    try {
      const png = await composeAnnotatedPng(initState, rect, strokes);
      const result = await invoke('CURSOR_ANNOTATION_COMMIT', {
        pngBase64: png,
        rect: { w: rect.w, h: rect.h },
      });
      if (!result?.success) {
        if (result?.error === 'too-large') {
          setError(`Annotated image too large (${(result.actualBytes / (1024 * 1024)).toFixed(1)} MB > 10 MB cap). Try shrinking the rectangle.`);
        } else {
          setError(result?.error || 'Failed to commit annotation.');
        }
      }
    } catch (err) {
      setError(err?.message || 'Failed to compose annotation.');
    }
  }, [initState, rect, strokes, invoke]);

  // Esc closes picker first, then cancels. Enter commits. Cmd/Ctrl+Z
  // undo, Cmd/Ctrl+Shift+Z redo. E toggles eraser, B toggles draw.
  useEffect(() => {
    const handler = (e) => {
      if (e.nativeEvent?.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pickerOpen) {
          setPickerOpen(null);
          return;
        }
        void invoke('CURSOR_ANNOTATION_CANCEL').catch(() => {});
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        commit();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (!mod && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setTool('erase');
      }
      if (!mod && (e.key === 'b' || e.key === 'B' || e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setTool('draw');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, rect, strokes, initState, pickerOpen]);

  // --- Live preview canvas ----------------------------------------------

  const previewCanvasRef = useRef(null);
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !rect || !initState) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = rect.w;
    canvas.height = rect.h;
    ctx.clearRect(0, 0, rect.w, rect.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, rect.w, rect.h);
    ctx.clip();
    for (const stroke of strokes) {
      drawStroke(ctx, stroke, 1);
    }
    ctx.restore();
  }, [strokes, rect, initState]);

  // --- Render ------------------------------------------------------------

  if (error && !initState) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(255,255,255,0.85)', fontFamily: "'Geist Sans', system-ui, sans-serif", fontSize: 14,
      }}>
        <div style={{ background: 'rgba(20,20,24,0.92)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => { void invoke('CURSOR_ANNOTATION_CANCEL').catch(() => {}); }}
            style={{ alignSelf: 'flex-end', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: 'inherit', borderRadius: 8, padding: '6px 12px', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!initState || !rect || !toolbarPos) {
    return <div style={{ position: 'fixed', inset: 0, background: '#000' }} />;
  }

  const display = initState.display;
  // Bottom-right move tab — adaptive: prefer below-right; flip above
  // (inside the rect, near the bottom-right) when the rect is flush
  // with the display bottom.
  const tabBelow = (display.height - (rect.y + rect.h)) >= (MOVE_TAB_H + MOVE_TAB_GAP + 4);
  const moveTabStyle = tabBelow
    ? { right: 0, top: rect.h + MOVE_TAB_GAP, borderRadius: '0 0 8px 8px' }
    : { right: 0, bottom: 0, borderRadius: '8px 0 0 0' };

  const cursorVal = pickerOpen
    ? 'default'
    : (drawing ? (tool === 'erase' ? 'cell' : 'crosshair') : (tool === 'erase' ? 'cell' : 'crosshair'));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        cursor: cursorVal,
      }}
      onMouseDown={startStroke}
    >
      {/* Freeze background */}
      <img
        src={initState.freezeDataUrl}
        alt=""
        draggable={false}
        style={{
          position: 'absolute', left: 0, top: 0,
          width: display.width, height: display.height,
          userSelect: 'none', pointerEvents: 'none',
        }}
      />

      {/* Dim outside the rectangle (4 panels — top, right, bottom, left) */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: display.width, height: rect.y, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: rect.x + rect.w, top: rect.y, width: display.width - rect.x - rect.w, height: rect.h, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, top: rect.y + rect.h, width: display.width, height: display.height - rect.y - rect.h, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, top: rect.y, width: rect.x, height: rect.h, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />

      {/* Rectangle (border + handles + preview canvas). Body has
          pointerEvents: none so it doesn't swallow strokes. */}
      <div
        style={{
          position: 'absolute', left: rect.x, top: rect.y,
          width: rect.w, height: rect.h,
          border: `1px solid ${ACCENT}`,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.4) inset',
          pointerEvents: 'none',
        }}
      >
        <canvas
          ref={previewCanvasRef}
          style={{ position: 'absolute', left: 0, top: 0, width: rect.w, height: rect.h, pointerEvents: 'none' }}
          width={rect.w}
          height={rect.h}
        />

        {/* Bottom-right move tab — adaptive position. */}
        <div
          onMouseDown={onRectMouseDown('move')}
          title="Drag region"
          style={{
            position: 'absolute',
            ...moveTabStyle,
            width: MOVE_TAB_W,
            height: MOVE_TAB_H,
            background: ACCENT,
            border: '1px solid rgba(255,255,255,0.35)',
            cursor: 'move',
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 3,
          }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.85)' }} />
          ))}
        </div>

        {/* Corner handles — circles. */}
        {['nw', 'ne', 'sw', 'se'].map((corner) => {
          const positions = {
            nw: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nwse-resize' },
            ne: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nesw-resize' },
            sw: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2, cursor: 'nesw-resize' },
            se: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2, cursor: 'nwse-resize' },
          };
          const p = positions[corner];
          return (
            <div
              key={corner}
              onMouseDown={onRectMouseDown(corner)}
              style={{
                position: 'absolute',
                width: HANDLE_SIZE, height: HANDLE_SIZE,
                background: ACCENT,
                border: '2px solid rgba(255,255,255,0.92)',
                borderRadius: '50%',
                pointerEvents: 'auto',
                ...p,
              }}
            />
          );
        })}
      </div>

      {/* Toolbar */}
      <Toolbar
        position={toolbarPos}
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        width={width}
        setWidth={setWidth}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        onUndo={undo}
        onRedo={redo}
        canUndo={history.length > 0}
        canRedo={redoHistory.length > 0}
        onCommit={commit}
        onCancel={() => { void invoke('CURSOR_ANNOTATION_CANCEL').catch(() => {}); }}
        onHandleDown={onToolbarHandleDown}
        dragging={draggingToolbar}
      />

      {/* Inline error banner */}
      {error && (
        <div
          style={{
            position: 'absolute',
            left: '50%', bottom: 24,
            transform: 'translateX(-50%)',
            background: 'rgba(160, 30, 30, 0.92)',
            border: '1px solid rgba(255, 120, 120, 0.4)',
            borderRadius: 10,
            padding: '8px 14px',
            color: '#fff',
            fontFamily: "'Geist Sans', system-ui, sans-serif",
            fontSize: 13,
            maxWidth: 480,
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'flex', alignItems: 'center', gap: 10,
            pointerEvents: 'auto',
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', padding: 2, display: 'flex' }}
            title="Dismiss"
          >
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Toolbar ─────────────────────────────────────────────────────────────

function Toolbar({
  position, tool, setTool,
  color, setColor, width, setWidth,
  pickerOpen, setPickerOpen,
  onUndo, onRedo, canUndo, canRedo,
  onCommit, onCancel, onHandleDown, dragging,
}) {
  // Stop propagation on the whole toolbar so clicks don't start
  // strokes on the underlying surface.
  const stopProp = useCallback((e) => { e.stopPropagation(); }, []);

  return (
    <div
      style={{
        position: 'absolute',
        left: position.x, top: position.y,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
        pointerEvents: 'auto',
      }}
      onMouseDown={stopProp}
    >
      {/* Color picker popover (above main toolbar) */}
      {pickerOpen === 'color' && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 12px', borderRadius: 999,
            background: PILL_BG, border: PILL_BORDER, boxShadow: PILL_SHADOW,
            backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
          }}
        >
          {ANNOTATION_COLORS.map((c) => {
            const selected = color === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => { setColor(c.value); setPickerOpen(null); }}
                title={c.label}
                style={{
                  width: 26, height: 26, borderRadius: 999,
                  background: c.value,
                  border: selected ? '2px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.16)',
                  boxShadow: c.value === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,0.24)' : 'none',
                  cursor: 'pointer', padding: 0,
                }}
              />
            );
          })}
        </div>
      )}

      {/* Thickness picker popover */}
      {pickerOpen === 'thickness' && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 12px', borderRadius: 999,
            background: PILL_BG, border: PILL_BORDER, boxShadow: PILL_SHADOW,
            backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
          }}
        >
          {STROKE_WIDTHS.map((w) => {
            const selected = width === w.value;
            const dotSize = 4 + w.value;
            return (
              <button
                key={w.value}
                type="button"
                onClick={() => { setWidth(w.value); setPickerOpen(null); }}
                title={w.label}
                style={{
                  width: 32, height: 32, borderRadius: 999,
                  background: selected ? 'rgba(75,90,255,0.18)' : 'transparent',
                  border: 'none', cursor: 'pointer', padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ width: dotSize, height: dotSize, borderRadius: 999, background: 'rgba(255,255,255,0.85)' }} />
              </button>
            );
          })}
        </div>
      )}

      {/* Main toolbar pill */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 8px',
          borderRadius: 999,
          background: PILL_BG,
          border: PILL_BORDER,
          boxShadow: PILL_SHADOW,
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          userSelect: 'none',
          cursor: dragging ? 'grabbing' : 'default',
        }}
      >
        {/* Drag handle */}
        <div
          onMouseDown={onHandleDown}
          title="Drag toolbar"
          style={{
            width: 16, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'grab', borderRadius: 4,
          }}
        >
          <span style={{ width: 2, height: 18, background: 'rgba(255,255,255,0.25)', borderRadius: 1 }} />
        </div>

        <ToolbarBtn
          title="Pen (B)"
          active={tool === 'draw'}
          onClick={() => { setTool('draw'); setPickerOpen(null); }}
        >
          <Pencil size={16} strokeWidth={2} />
        </ToolbarBtn>

        <ToolbarBtn
          title="Eraser (E)"
          active={tool === 'erase'}
          onClick={() => { setTool('erase'); setPickerOpen(null); }}
        >
          <Eraser size={16} strokeWidth={2} />
        </ToolbarBtn>

        <ToolbarBtn
          title="Color"
          active={pickerOpen === 'color'}
          onClick={() => setPickerOpen((p) => (p === 'color' ? null : 'color'))}
        >
          <span style={{
            width: 18, height: 18, borderRadius: 999, background: color,
            boxShadow: color === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,0.4)' : 'none',
          }} />
        </ToolbarBtn>

        <ToolbarBtn
          title="Thickness"
          active={pickerOpen === 'thickness'}
          onClick={() => setPickerOpen((p) => (p === 'thickness' ? null : 'thickness'))}
        >
          <span style={{
            width: 4 + width, height: 4 + width, borderRadius: 999, background: 'rgba(255,255,255,0.85)',
          }} />
        </ToolbarBtn>

        <Divider />

        <ToolbarBtn title="Undo (⌘Z)" onClick={onUndo} disabled={!canUndo}>
          <Undo2 size={16} strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn title="Redo (⌘⇧Z)" onClick={onRedo} disabled={!canRedo}>
          <Redo2 size={16} strokeWidth={2} />
        </ToolbarBtn>

        <Divider />

        <ToolbarBtn title="Cancel (Esc)" onClick={onCancel}>
          <X size={16} strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn title="Done (↵)" accent onClick={onCommit}>
          <Check size={16} strokeWidth={2.4} />
        </ToolbarBtn>
      </div>
    </div>
  );
}

function ToolbarBtn({ active, accent, disabled, onClick, title, children }) {
  let bg = 'transparent';
  let fg = 'rgba(255,255,255,0.85)';
  if (accent) {
    bg = ACCENT;
    fg = '#fff';
  } else if (active) {
    bg = 'rgba(75,90,255,0.22)';
    fg = '#fff';
  } else if (disabled) {
    fg = 'rgba(255,255,255,0.3)';
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 36, height: 36, borderRadius: 999,
        background: bg, color: fg,
        border: 'none', padding: 0, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background-color 160ms ease',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.1)', margin: '0 2px' }} />;
}

// ─── Composite ───────────────────────────────────────────────────────────

async function composeAnnotatedPng(initState, rect, strokes) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = img.naturalWidth / initState.display.width;
        const sx = rect.x * scale;
        const sy = rect.y * scale;
        const sw = rect.w * scale;
        const sh = rect.h * scale;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(sw);
        canvas.height = Math.round(sh);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        for (const stroke of strokes) {
          drawStroke(ctx, stroke, scale);
        }
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',', 2)[1] || '';
        resolve(base64);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load freeze image'));
    img.src = initState.freezeDataUrl;
  });
}

export default CursorAnnotationView;
