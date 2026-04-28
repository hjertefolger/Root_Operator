/**
 * Cursor annotation surface.
 *
 * Mounted into a borderless fullscreen NSPanel created by
 * src/main/cursor-annotation.js. Hydrates the freeze image + display
 * geometry + initial rect on mount, then hosts:
 *   - background freeze image
 *   - dim overlay outside the rectangle
 *   - rectangle: drag body to move, drag corners to resize
 *   - toolbar: color, width, undo/redo, cancel, done
 *   - drawing surface (strokes only render inside the rectangle)
 *
 * On commit: composes the freeze + strokes onto an offscreen canvas at
 * native resolution, base64-encodes the PNG bytes, ships via IPC. Main
 * writes the file (renderer is sandboxed; we don't trust renderer paths).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useElectron } from '../hooks/useElectron';
import { ANNOTATION_COLORS, STROKE_WIDTHS, drawStroke } from '../../shared/annotation-constants';
import { Undo2, Redo2, Check, X } from 'lucide-react';

const TOOLBAR_GAP = 12;
const HANDLE_SIZE = 10;
const MIN_RECT = 200;

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function CursorAnnotationView() {
  const { invoke } = useElectron();

  const [initState, setInitState] = useState(null);
  const [error, setError] = useState(null);
  const [rect, setRect] = useState(null);
  const [strokes, setStrokes] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [color, setColor] = useState(ANNOTATION_COLORS[1].value); // Red default — most common annotation
  const [width, setWidth] = useState(STROKE_WIDTHS[1].value);
  const [drawing, setDrawing] = useState(false);
  const [toolbarPos, setToolbarPos] = useState(null); // { x, y } - position relative to window
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
      // Toolbar starts to the right of the rectangle, clamped onscreen.
      const initToolbarX = clamp(state.rect.x + state.rect.w + TOOLBAR_GAP, 8, state.display.width - 240);
      const initToolbarY = clamp(state.rect.y, 8, state.display.height - 200);
      setToolbarPos({ x: initToolbarX, y: initToolbarY });
    }).catch((err) => {
      if (cancelled) return;
      setError(err?.message || 'Failed to load annotation state.');
    });
    return () => { cancelled = true; };
  }, [invoke]);

  // Esc cancels, Enter commits.
  useEffect(() => {
    const handler = (e) => {
      if (e.nativeEvent?.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        void invoke('CURSOR_ANNOTATION_CANCEL').catch(() => {});
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, rect, strokes, initState]);

  // Drawing handlers (only operate inside the rectangle).
  const startStroke = useCallback((e) => {
    if (!rect) return;
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return;
    setStrokes((prev) => [...prev, { color, width, points: [{ x: x - rect.x, y: y - rect.y }] }]);
    setRedoStack([]);
    setDrawing(true);
  }, [rect, color, width]);

  const continueStroke = useCallback((e) => {
    if (!drawing || !rect) return;
    const px = e.clientX;
    const py = e.clientY;
    // Clip to rectangle bounds (don't extend strokes outside the canvas).
    if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return;
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        points: [...last.points, { x: px - rect.x, y: py - rect.y }],
      };
      return next;
    });
  }, [drawing, rect]);

  const endStroke = useCallback(() => {
    setDrawing(false);
  }, []);

  // Rect drag-to-move + corner handles.
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

  // Toolbar drag.
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

  // Pointer-move dispatcher: routes to drawing OR active drag depending
  // on which pointerdown started.
  useEffect(() => {
    const onMove = (e) => {
      const drag = dragStateRef.current;
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (drag.mode === 'toolbar') {
          if (initState) {
            setToolbarPos({
              x: clamp(drag.startToolbar.x + dx, 0, initState.display.width - 200),
              y: clamp(drag.startToolbar.y + dy, 0, initState.display.height - 100),
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

  const undo = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      setRedoStack((r) => [...r, prev[prev.length - 1]]);
      return next;
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const last = r[r.length - 1];
      setStrokes((s) => [...s, last]);
      return r.slice(0, -1);
    });
  }, []);

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

  // Live preview: draw freeze + dim + strokes inside the rect.
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

  // Fatal errors only — load failures we can't recover from.
  // Soft errors (too-large at commit) render inline below, keeping the
  // editor open so the user can shrink the rectangle and try again.
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

  return (
    <div
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        cursor: drawing ? 'crosshair' : 'default',
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

      {/* Rectangle border (no drag-body — would swallow mousedown
          and prevent stroke start). Move uses the explicit grip handle
          at the top-left corner; corners resize. */}
      <div
        style={{
          position: 'absolute', left: rect.x, top: rect.y,
          width: rect.w, height: rect.h,
          border: '1px solid rgba(75, 90, 255, 0.85)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.4) inset',
          pointerEvents: 'none',
        }}
      >
        {/* Stroke preview canvas */}
        <canvas
          ref={previewCanvasRef}
          style={{ position: 'absolute', left: 0, top: 0, width: rect.w, height: rect.h, pointerEvents: 'none' }}
          width={rect.w}
          height={rect.h}
        />

        {/* Move grip — small handle at top-left, deliberate move action */}
        <div
          onMouseDown={onRectMouseDown('move')}
          title="Drag region"
          style={{
            position: 'absolute',
            left: -2, top: -22,
            width: 22, height: 20,
            background: 'rgba(75, 90, 255, 0.85)',
            border: '1px solid rgba(255,255,255,0.4)',
            borderRadius: '4px 4px 0 0',
            cursor: 'move',
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ width: 10, height: 1, background: 'rgba(255,255,255,0.85)' }} />
            <div style={{ width: 10, height: 1, background: 'rgba(255,255,255,0.85)' }} />
            <div style={{ width: 10, height: 1, background: 'rgba(255,255,255,0.85)' }} />
          </div>
        </div>

        {/* Corner handles */}
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
                background: '#4B5AFF',
                border: '1px solid rgba(255,255,255,0.85)',
                borderRadius: 2,
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
        color={color}
        setColor={setColor}
        width={width}
        setWidth={setWidth}
        onUndo={undo}
        onRedo={redo}
        canUndo={strokes.length > 0}
        canRedo={redoStack.length > 0}
        onCommit={commit}
        onCancel={() => { void invoke('CURSOR_ANNOTATION_CANCEL').catch(() => {}); }}
        onHandleDown={onToolbarHandleDown}
        dragging={draggingToolbar}
      />

      {/* Inline error banner — keeps editor visible so the user can act */}
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

function Toolbar({
  position, color, setColor, width, setWidth,
  onUndo, onRedo, canUndo, canRedo,
  onCommit, onCancel, onHandleDown, dragging,
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: position.x, top: position.y,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px',
        background: 'rgba(20, 20, 24, 0.94)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 14,
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        userSelect: 'none',
        cursor: dragging ? 'grabbing' : 'default',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onHandleDown}
        style={{
          width: 12, height: 24, borderRadius: 4,
          background: 'rgba(255,255,255,0.05)',
          cursor: 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Drag toolbar"
      >
        <div style={{ width: 2, height: 14, background: 'rgba(255,255,255,0.25)', borderRadius: 1 }} />
      </div>

      {/* Color swatches */}
      <div style={{ display: 'flex', gap: 4 }}>
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setColor(c.value)}
            title={c.label}
            style={{
              width: 22, height: 22, borderRadius: '50%',
              background: c.value,
              border: color === c.value ? '2px solid rgba(255,255,255,0.95)' : '1px solid rgba(255,255,255,0.18)',
              cursor: 'pointer', padding: 0,
            }}
          />
        ))}
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.1)' }} />

      {/* Stroke widths */}
      <div style={{ display: 'flex', gap: 4 }}>
        {STROKE_WIDTHS.map((w) => (
          <button
            key={w.value}
            type="button"
            onClick={() => setWidth(w.value)}
            title={w.label}
            style={{
              width: 26, height: 22, borderRadius: 6,
              background: width === w.value ? 'rgba(75, 90, 255, 0.25)' : 'transparent',
              border: width === w.value ? '1px solid rgba(75, 90, 255, 0.7)' : '1px solid rgba(255,255,255,0.15)',
              cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div style={{ width: 14, height: w.value, background: 'rgba(255,255,255,0.85)', borderRadius: w.value }} />
          </button>
        ))}
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.1)' }} />

      {/* Undo / Redo */}
      <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo" style={iconButtonStyle(!canUndo)}>
        <Undo2 size={16} strokeWidth={2} />
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} title="Redo" style={iconButtonStyle(!canRedo)}>
        <Redo2 size={16} strokeWidth={2} />
      </button>

      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.1)' }} />

      {/* Cancel / Done */}
      <button type="button" onClick={onCancel} title="Cancel (Esc)" style={iconButtonStyle(false)}>
        <X size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={onCommit}
        title="Done (Enter)"
        style={{
          ...iconButtonStyle(false),
          background: 'rgba(75, 90, 255, 0.85)',
          color: '#fff',
        }}
      >
        <Check size={16} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function iconButtonStyle(disabled) {
  return {
    width: 28, height: 26, borderRadius: 8,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: disabled ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.85)',
    cursor: disabled ? 'default' : 'pointer',
    padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    opacity: disabled ? 0.5 : 1,
  };
}

/**
 * Composite freeze image (cropped to rect) + strokes onto an offscreen
 * canvas at native resolution. Returns base64 PNG.
 */
async function composeAnnotatedPng(initState, rect, strokes) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        // Native scale: how many physical pixels per CSS pixel in the
        // captured image. The freeze PNG is at native resolution; the
        // displayed rect is in CSS pixels of the display.
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
        // Strokes are stored in CSS-px space relative to the rect.
        // displayScale maps them onto the native composite.
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
