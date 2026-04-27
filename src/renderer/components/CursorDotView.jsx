/**
 * The cursor companion's passive dot. Sits in a 24×24 always-on-top
 * click-through window that the main process repositions every cursor
 * frame. The dot itself is drawn centered with a soft glow so it reads
 * as a presence rather than a UI affordance.
 */
function CursorDotView() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        // The window itself is click-through (setIgnoreMouseEvents in main).
        // pointerEvents: 'none' here is belt-and-braces for safety in dev.
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#4B5AFF',
          boxShadow:
            '0 0 0 1.5px rgba(75, 90, 255, 0.35), ' +
            '0 0 8px 2px rgba(75, 90, 255, 0.25)',
        }}
      />
    </div>
  );
}

export default CursorDotView;
