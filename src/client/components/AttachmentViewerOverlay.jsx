import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ArrowUp, ChevronLeft, ChevronRight, Highlighter, Loader, Maximize2, Pause, Play, Plus, Redo2, Trash, Trash2, Undo2, Volume2, VolumeX, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ANNOTATION_COLORS, STROKE_WIDTHS, drawStroke } from '../../shared/annotation-constants';

const docRemarkPlugins = [remarkGfm];

// Editorial dark style for rendered markdown documents in the viewer.
// Heavier line-height + larger headings than chat bubbles — these are
// long-form docs the user reads, not short messages.
const docMdComponents = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 26, fontWeight: 600, color: '#fff', letterSpacing: '-0.025em', lineHeight: 1.2, margin: '32px 0 14px' }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 19, fontWeight: 600, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.015em', margin: '32px 0 12px' }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgba(255,255,255,0.92)', margin: '24px 0 8px' }}>{children}</h3>
  ),
  p: ({ children }) => (
    <p style={{ fontSize: 15, lineHeight: 1.65, color: 'rgba(255,255,255,0.78)', margin: '0 0 14px' }}>{children}</p>
  ),
  strong: ({ children }) => <strong style={{ color: 'rgba(255,255,255,0.95)', fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ color: 'rgba(255,255,255,0.85)', fontStyle: 'italic' }}>{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: '#c9854a', textDecoration: 'none' }}>{children}</a>
  ),
  ul: ({ children }) => <ul style={{ margin: '6px 0 16px 20px', color: 'rgba(255,255,255,0.78)', fontSize: 15, lineHeight: 1.65 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '6px 0 16px 22px', color: 'rgba(255,255,255,0.78)', fontSize: 15, lineHeight: 1.65 }}>{children}</ol>,
  li: ({ children }) => <li style={{ padding: '3px 0' }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote style={{ borderLeft: '2px solid #c9854a', background: 'rgba(255,255,255,0.03)', borderRadius: 4, padding: '12px 16px', margin: '14px 0', color: 'rgba(255,255,255,0.88)', fontSize: 15 }}>{children}</blockquote>
  ),
  hr: () => <hr style={{ border: 'none', borderTop: '1px dashed rgba(255,255,255,0.12)', margin: '28px 0' }} />,
  code: ({ inline, children }) => (
    inline
      ? <code style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, color: 'rgba(255,255,255,0.92)' }}>{children}</code>
      : <code style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.92)' }}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 14, margin: '12px 0', overflowX: 'auto', whiteSpace: 'pre' }}>{children}</pre>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', margin: '14px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.55)', textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.78)', verticalAlign: 'top' }}>{children}</td>
  ),
};

function decodeBase64Utf8(b64) {
  if (typeof b64 !== 'string' || !b64) {
    return '';
  }
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

const MAX_SCALE = 6;
const MAX_WEB_ZOOM = 8;
const MIN_SCALE = 1;
const WEB_ZOOM_EPSILON = 0.001;
const SWIPE_NAV_DISTANCE = 72;
const SWIPE_NAV_LONG_DISTANCE = 120;
const SWIPE_NAV_VELOCITY = 0.35;
const SWIPE_NAV_VERTICAL_DRIFT = 48;
const EMPTY_ANNOTATIONS = { strokes: [], redo: [] };
const EMPTY_DOC_QUEUE = Object.freeze([]);
const EMPTY_VIEWPORT_RECT = { width: 0, height: 0, left: 0, top: 0 };

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewportFallbackRect() {
  if (typeof window === 'undefined') {
    return EMPTY_VIEWPORT_RECT;
  }

  const visualViewport = window.visualViewport;
  return {
    width: Math.max(0, visualViewport?.width || window.innerWidth || 0),
    height: Math.max(0, visualViewport?.height || window.innerHeight || 0),
    left: visualViewport?.offsetLeft || 0,
    top: visualViewport?.offsetTop || 0,
  };
}

function normalizeViewportRect(rect) {
  const fallback = getViewportFallbackRect();
  if (!rect) {
    return fallback;
  }

  const width = Math.max(0, rect.width || 0);
  const height = Math.max(0, rect.height || 0);
  if (width > 0 && height > 0) {
    return {
      width,
      height,
      left: rect.left || 0,
      top: rect.top || 0,
    };
  }

  return fallback;
}

function isSameViewportRect(left, right) {
  return left.width === right.width
    && left.height === right.height
    && left.left === right.left
    && left.top === right.top;
}

function getStageMetrics({ naturalSize, viewportRect, useLayoutZoomViewer, fitScaleLimit }) {
  const hasNaturalSize = naturalSize.width > 0 && naturalSize.height > 0;
  const fitScale = (hasNaturalSize && viewportRect.width > 0 && viewportRect.height > 0)
    ? Math.min(
        viewportRect.width / naturalSize.width,
        viewportRect.height / naturalSize.height,
        fitScaleLimit
      )
    : 0;
  const stageWidth = fitScale > 0
    ? naturalSize.width * fitScale
    : (useLayoutZoomViewer ? viewportRect.width : 0);
  const stageHeight = fitScale > 0
    ? naturalSize.height * fitScale
    : (useLayoutZoomViewer ? viewportRect.height : 0);

  return {
    hasNaturalSize,
    fitScale,
    stageWidth,
    stageHeight,
    hasStage: stageWidth > 0 && stageHeight > 0,
  };
}

function getAttachmentPreviewSrc(attachment) {
  if (!attachment?.bytesBase64 || !attachment?.mime) {
    return '';
  }
  return `data:${attachment.mime};base64,${attachment.bytesBase64}`;
}

function getViewportPoint(pointA, pointB) {
  const center = {
    x: (pointA.x + pointB.x) / 2,
    y: (pointA.y + pointB.y) / 2,
  };
  const distance = Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  return { center, distance };
}

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }

  const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
  return Boolean(target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select');
}

function getAttachmentAnnotationKey(attachment, index) {
  if (!attachment) {
    return `attachment-${index}`;
  }
  return attachment.id || `${attachment.name || 'attachment'}-${index}`;
}

function getImagePointFromClient({
  clientX,
  clientY,
  stageRect,
  naturalWidth,
  naturalHeight,
}) {
  if (!stageRect || !stageRect.width || !stageRect.height || !naturalWidth || !naturalHeight) {
    return null;
  }

  const baseX = clientX - stageRect.left;
  const baseY = clientY - stageRect.top;

  if (baseX < 0 || baseY < 0 || baseX > stageRect.width || baseY > stageRect.height) {
    return null;
  }

  return {
    x: baseX * (naturalWidth / stageRect.width),
    y: baseY * (naturalHeight / stageRect.height),
  };
}

function buildAnnotatedFileName(name) {
  const fallbackName = typeof name === 'string' && name.trim() ? name.trim() : 'attachment';
  const dotIndex = fallbackName.lastIndexOf('.');
  const stem = dotIndex > 0 ? fallbackName.slice(0, dotIndex) : fallbackName;
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
  ].join('')
    + '-'
    + [
      `${now.getHours()}`.padStart(2, '0'),
      `${now.getMinutes()}`.padStart(2, '0'),
      `${now.getSeconds()}`.padStart(2, '0'),
    ].join('');
  return `${stem}-annotated-${timestamp}.png`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode PNG'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function VideoControlsPill({ videoRef }) {
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video) {
      return undefined;
    }

    const syncFromVideo = () => {
      setPaused(video.paused);
      setMuted(video.muted);
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(dur);
      if (!isScrubbing) {
        setCurrentTime(video.currentTime || 0);
      }
    };

    syncFromVideo();

    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onTimeUpdate = () => {
      if (!isScrubbing) {
        setCurrentTime(video.currentTime || 0);
      }
    };
    const onDurationChange = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(dur);
    };
    const onVolumeChange = () => setMuted(video.muted);

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onDurationChange);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('volumechange', onVolumeChange);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onDurationChange);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('volumechange', onVolumeChange);
    };
  }, [isScrubbing, videoRef]);

  const handlePlayPause = useCallback(() => {
    const video = videoRef?.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [videoRef]);

  const handleMuteToggle = useCallback(() => {
    const video = videoRef?.current;
    if (!video) return;
    video.muted = !video.muted;
  }, [videoRef]);

  const handleFullscreen = useCallback(() => {
    const video = videoRef?.current;
    if (!video) return;
    // iOS Safari and iOS PWAs don't implement the standard Fullscreen API on
    // <video>; they expose webkitEnterFullscreen which hands off to the
    // native iOS video player. Try that first on mobile WebKit, fall back to
    // the standard API for desktop Chrome/Safari/Firefox.
    if (typeof video.webkitEnterFullscreen === 'function') {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch {
        // Fall through to standard API.
      }
    }
    const request =
      video.requestFullscreen
      || video.webkitRequestFullscreen
      || video.msRequestFullscreen;
    if (request) {
      const result = request.call(video);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    }
  }, [videoRef]);

  const handleScrubStart = useCallback((event) => {
    setIsScrubbing(true);
    setScrubValue(Number(event.target.value));
  }, []);

  const handleScrubChange = useCallback((event) => {
    setScrubValue(Number(event.target.value));
  }, []);

  const handleScrubEnd = useCallback((event) => {
    const video = videoRef?.current;
    const target = Number(event.target.value);
    if (video && Number.isFinite(target)) {
      video.currentTime = target;
      setCurrentTime(target);
    }
    setIsScrubbing(false);
  }, [videoRef]);

  const displayedTime = isScrubbing ? scrubValue : currentTime;
  const hasDuration = Number.isFinite(duration) && duration > 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '6px 10px 6px 8px',
        borderRadius: 999,
        background: 'rgba(10,10,10,0.82)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        backdropFilter: 'blur(18px)',
        pointerEvents: 'auto',
        minWidth: 'min(calc(100vw - 48px), 420px)',
      }}
    >
      <IconButton
        onClick={handlePlayPause}
        ariaLabel={paused ? 'Play' : 'Pause'}
        activeStrong
      >
        {paused ? <Play size={16} strokeWidth={2.1} /> : <Pause size={16} strokeWidth={2.1} />}
      </IconButton>

      <input
        type="range"
        min={0}
        max={hasDuration ? duration : 0}
        step={0.1}
        value={hasDuration ? displayedTime : 0}
        onMouseDown={handleScrubStart}
        onTouchStart={handleScrubStart}
        onChange={handleScrubChange}
        onMouseUp={handleScrubEnd}
        onTouchEnd={handleScrubEnd}
        disabled={!hasDuration}
        aria-label="Seek"
        style={{
          flex: 1,
          appearance: 'none',
          WebkitAppearance: 'none',
          height: 4,
          borderRadius: 999,
          background: `linear-gradient(to right, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.85) ${
            hasDuration ? (displayedTime / duration) * 100 : 0
          }%, rgba(255,255,255,0.16) ${
            hasDuration ? (displayedTime / duration) * 100 : 0
          }%, rgba(255,255,255,0.16) 100%)`,
          outline: 'none',
          cursor: hasDuration ? 'pointer' : 'default',
          opacity: hasDuration ? 1 : 0.4,
        }}
      />

      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          color: 'rgba(255,255,255,0.72)',
          whiteSpace: 'nowrap',
          minWidth: 76,
          textAlign: 'center',
        }}
      >
        {formatVideoTime(displayedTime)} / {formatVideoTime(duration)}
      </span>

      <IconButton onClick={handleMuteToggle} ariaLabel={muted ? 'Unmute' : 'Mute'}>
        {muted ? <VolumeX size={16} strokeWidth={2.1} /> : <Volume2 size={16} strokeWidth={2.1} />}
      </IconButton>

      <IconButton onClick={handleFullscreen} ariaLabel="Fullscreen">
        <Maximize2 size={16} strokeWidth={2.1} />
      </IconButton>
    </div>
  );
}

function IconButton({ children, onClick, disabled, active, activeStrong, accent, ariaLabel }) {
  let background = 'transparent';
  let color = 'rgba(255,255,255,0.82)';
  if (accent) {
    background = disabled ? 'rgba(255,255,255,0.06)' : '#4B5AFF';
    color = disabled ? 'rgba(255,255,255,0.42)' : '#ffffff';
  } else if (activeStrong && active) {
    background = '#4B5AFF';
    color = '#ffffff';
  } else if (active) {
    background = 'rgba(75,90,255,0.18)';
    color = '#c8ceff';
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active || undefined}
      style={{
        width: 36,
        height: 36,
        borderRadius: 999,
        border: 'none',
        background,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.36 : 1,
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
        transition: 'background-color 160ms ease',
      }}
    >
      {children}
    </button>
  );
}

// Owns the markdown render and the inline annotation marker mutations for
// a single document attachment. Mounted with a key tied to the attachment
// so React tears the entire subtree down (and runs the heal cleanup) before
// the next attachment commits — eliminating any reconciliation overlap
// between marker mutations and react-markdown's rendered DOM.
const DocBody = memo(function DocBody({
  isMarkdownDoc,
  docSource,
  docRemarkPlugins,
  docMdComponents,
  preStyle,
  annotations,
  highlightTick,
  highlightRects,
  openAnnotationRef,
  onContentRefChange,
}) {
  const localRef = useRef(null);
  const setNode = useCallback((node) => {
    localRef.current = node;
    if (typeof onContentRefChange === 'function') {
      onContentRefChange(node);
    }
  }, [onContentRefChange]);

  const healAllMarkers = useCallback(() => {
    const root = localRef.current;
    if (!root) return;
    root.querySelectorAll('[data-ann-host]').forEach((host) => {
      const parent = host.parentNode;
      if (!parent) return;
      const before = host.previousSibling;
      const after = host.nextSibling;
      parent.removeChild(host);
      if (
        before
        && after
        && before.nodeType === Node.TEXT_NODE
        && after.nodeType === Node.TEXT_NODE
      ) {
        before.data += after.data;
        parent.removeChild(after);
      }
    });
  }, []);

  // Sweep on unmount so the OLD subtree is fully healed before React
  // discards it. Because DocBody is keyed by attachment in the parent,
  // unmount fires synchronously when the attachment changes — well
  // before the new DocBody (and its react-markdown children) commit.
  useLayoutEffect(() => {
    return () => {
      healAllMarkers();
    };
  }, [healAllMarkers]);

  // Keep markers in sync with the queued annotations. Idempotent: hosts
  // we already created are matched by data-ann-host id, orphans are
  // healed.
  useLayoutEffect(() => {
    const root = localRef.current;
    if (!root) return;

    const removeHostAndHeal = (host) => {
      if (!host || !host.parentNode) return;
      const parent = host.parentNode;
      const before = host.previousSibling;
      const after = host.nextSibling;
      parent.removeChild(host);
      if (
        before
        && after
        && before.nodeType === Node.TEXT_NODE
        && after.nodeType === Node.TEXT_NODE
      ) {
        before.data += after.data;
        parent.removeChild(after);
      }
    };

    const existing = new Map();
    root.querySelectorAll('[data-ann-host]').forEach((el) => {
      existing.set(el.dataset.annHost, el);
    });

    for (const entry of annotations) {
      if (existing.has(entry.id)) {
        existing.delete(entry.id);
        continue;
      }
      if (!entry.range) continue;
      // Defensive guard: a Range from a previous attachment can outlive
      // its DOM if state ever races. Skip silently if the range's
      // endContainer is no longer attached to this DocBody's subtree.
      if (!root.contains(entry.range.endContainer)) continue;
      try {
        const host = document.createElement('button');
        host.type = 'button';
        host.dataset.annHost = entry.id;
        host.setAttribute('aria-label', 'Edit annotation');
        Object.assign(host.style, {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          margin: '0 4px',
          verticalAlign: 'middle',
          borderRadius: '999px',
          border: 'none',
          padding: '0',
          background: '#4B5AFF',
          boxShadow: '0 4px 10px rgba(75,90,255,0.45)',
          cursor: 'pointer',
          flexShrink: '0',
        });
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '11');
        svg.setAttribute('height', '11');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', '#fff');
        svg.setAttribute('stroke-width', '2.4');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', '12');
        dot.setAttribute('cy', '10');
        dot.setAttribute('r', '1.5');
        dot.setAttribute('fill', '#fff');
        dot.setAttribute('stroke', 'none');
        svg.appendChild(path);
        svg.appendChild(dot);
        host.appendChild(svg);
        host.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          openAnnotationRef.current?.(entry.id);
        });

        const end = entry.range.endContainer;
        const offset = entry.range.endOffset;
        if (end && end.nodeType === Node.TEXT_NODE && end.parentNode) {
          if (offset >= end.length) {
            end.parentNode.insertBefore(host, end.nextSibling);
          } else {
            const after = end.splitText(offset);
            after.parentNode.insertBefore(host, after);
          }
        } else if (end && end.nodeType === Node.ELEMENT_NODE) {
          const refNode = end.childNodes[offset] || null;
          end.insertBefore(host, refNode);
        }
      } catch {
        // Range invalid or detached; skip silently.
      }
    }

    existing.forEach(removeHostAndHeal);
  }, [annotations, highlightTick, openAnnotationRef]);

  return (
    <div ref={setNode} style={{ position: 'relative' }}>
      {isMarkdownDoc ? (
        <ReactMarkdown remarkPlugins={docRemarkPlugins} components={docMdComponents}>
          {docSource}
        </ReactMarkdown>
      ) : (
        <pre style={preStyle}>{docSource}</pre>
      )}
      {Array.isArray(highlightRects) && highlightRects.map((rect) => (
        <div
          key={rect.id}
          style={{
            position: 'absolute',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            background: 'rgba(75,90,255,0.40)',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        />
      ))}
    </div>
  );
});

const AttachmentViewerOverlay = memo(function AttachmentViewerOverlay({
  attachments,
  externalRef,
  initialIndex = 0,
  attachmentCache,
  attachmentFetchState,
  onRequestAttachment,
  onQueueAnnotatedAttachment,
  onSendAnnotatedAttachment,
  onSendDocAnnotation,
  onClose,
}) {
  const viewportRef = useRef(null);
  const docContainerRef = useRef(null);
  // The doc content node is owned by a keyed child component (DocBody)
  // so its DOM mutations (annotation markers) are contained within a
  // subtree React fully unmounts on attachment changes. We hold the
  // current node here via a ref-callback for the parent's read-only
  // queries (selection, highlight rect computation).
  const [docContentNode, setDocContentNode] = useState(null);
  const viewportRectRef = useRef(getViewportFallbackRect());
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const videoRef = useRef(null);
  const contentRef = useRef(null);
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const webViewRef = useRef({ zoom: 1, x: 0, y: 0 });
  const webViewFrameRef = useRef(0);
  const webPendingViewRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef({ mode: 'idle' });
  // Tap tracking — stage handlers call preventDefault() on pointerdown, which
  // suppresses the synthesized click event, so onClick on nested <video> does
  // not fire reliably. We synthesize a tap from pointerdown/up deltas here.
  const tapStartRef = useRef(null);
  const TAP_MAX_DISTANCE = 8;
  const TAP_MAX_DURATION = 500;
  const drawingPointerIdRef = useRef(null);
  const draftStrokeRef = useRef(null);
  const renderFrameRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [viewportRect, setViewportRect] = useState(() => viewportRectRef.current);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const naturalSizeRef = useRef({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState(() => naturalSizeRef.current);
  const [imageLoadError, setImageLoadError] = useState('');
  const [annotationState, setAnnotationState] = useState({});
  const [drawEnabled, setDrawEnabled] = useState(false);
  const [selectedColor, setSelectedColor] = useState(ANNOTATION_COLORS[0].value);
  const [selectedWidth, setSelectedWidth] = useState(STROKE_WIDTHS[1].value);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [openPicker, setOpenPicker] = useState(null);
  const [webView, setWebView] = useState({ zoom: 1, x: 0, y: 0 });
  const [docSelection, setDocSelection] = useState(null);
  const [docCommentSheet, setDocCommentSheet] = useState(null);
  const [docCommentDraft, setDocCommentDraft] = useState('');
  const [docAnnotationSending, setDocAnnotationSending] = useState(false);
  const [docAnnotationError, setDocAnnotationError] = useState('');
  // Internal queue store carries the attachmentId it belongs to so a stale
  // queue from the previous attachment can never be observed during the
  // single render in which we're swapping. The derived `docAnnotationQueue`
  // below reads as the empty queue whenever the stored id no longer
  // matches the active attachment — DocBody mounts with no markers to
  // place, even before the post-commit cleanup useEffect runs.
  const [annotationQueueScoped, setAnnotationQueueScoped] = useState({ attachmentId: '', items: [] });
  const [highlightTick, setHighlightTick] = useState(0);
  const [docSheetDragY, setDocSheetDragY] = useState(0);
  const docSheetDragRef = useRef({ active: false, startY: 0, lastY: 0 });
  const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
  const isDesktopSurface = typeof window !== 'undefined' && Boolean(window.electronAPI);
  const useLayoutZoomViewer = !isDesktopSurface;
  const activeAttachment = attachmentCount > 0 ? attachments[activeIndex] : null;
  const attachmentId = activeAttachment?.id || '';
  const docAnnotationQueue = annotationQueueScoped.attachmentId === attachmentId
    ? annotationQueueScoped.items
    : EMPTY_DOC_QUEUE;
  const setDocAnnotationQueue = useCallback((updater) => {
    setAnnotationQueueScoped((prev) => {
      const base = prev.attachmentId === attachmentId ? prev.items : [];
      const nextItems = typeof updater === 'function' ? updater(base) : updater;
      return { attachmentId, items: nextItems };
    });
  }, [attachmentId]);
  const cachedAttachment = attachmentId ? attachmentCache?.[attachmentId] : null;
  const resolvedAttachment = cachedAttachment
    ? { ...activeAttachment, ...cachedAttachment }
    : activeAttachment;
  const previewSrc = getAttachmentPreviewSrc(resolvedAttachment);
  const resolvedMime = String(resolvedAttachment?.mime || '').toLowerCase();
  const isVideoAttachment = resolvedMime.startsWith('video/');
  const isDocAttachment = resolvedMime === 'text/markdown' || resolvedMime === 'text/plain';
  const isMarkdownDoc = resolvedMime === 'text/markdown';
  const docSource = useMemo(
    () => (isDocAttachment ? decodeBase64Utf8(resolvedAttachment?.bytesBase64) : ''),
    [isDocAttachment, resolvedAttachment?.bytesBase64],
  );
  const fetchState = attachmentId ? attachmentFetchState?.[attachmentId] : null;
  const isLoading = fetchState?.loading === true;
  const fetchError = fetchState?.error || '';
  const errorMessage = imageLoadError || fetchError;
  const canFetch = Boolean(!previewSrc && typeof onRequestAttachment === 'function' && attachmentId && externalRef);
  const annotationKey = getAttachmentAnnotationKey(activeAttachment, activeIndex);
  const currentAnnotations = annotationState[annotationKey] || EMPTY_ANNOTATIONS;
  const strokes = currentAnnotations.strokes || EMPTY_ANNOTATIONS.strokes;
  const redoStack = currentAnnotations.redo || EMPTY_ANNOTATIONS.redo;
  const hasAnnotations = strokes.length > 0;
  const annotatedAttachmentHandler = onQueueAnnotatedAttachment || onSendAnnotatedAttachment;
  const hasNaturalSize = naturalSize.width > 0 && naturalSize.height > 0;
  const canSendAnnotated = Boolean(
    hasAnnotations
    && !isSending
    && typeof annotatedAttachmentHandler === 'function'
    && imageRef.current
    && hasNaturalSize
    && !errorMessage
  );

  const fitScaleLimit =
    !useLayoutZoomViewer && typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? 1 / window.devicePixelRatio
      : Number.POSITIVE_INFINITY;
  const {
    fitScale,
    stageWidth,
    stageHeight,
    hasStage,
  } = getStageMetrics({
    naturalSize,
    viewportRect,
    useLayoutZoomViewer,
    fitScaleLimit,
  });
  const stageDisplayWidth = useLayoutZoomViewer ? stageWidth * webView.zoom : stageWidth;
  const stageDisplayHeight = useLayoutZoomViewer ? stageHeight * webView.zoom : stageHeight;
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < (attachmentCount - 1);

  const measureViewport = useCallback((node = viewportRef.current) => {
    const nextRect = normalizeViewportRect(node?.getBoundingClientRect?.());
    viewportRectRef.current = nextRect;
    setViewportRect((current) => (isSameViewportRect(current, nextRect) ? current : nextRect));
    return nextRect;
  }, []);

  const handleViewportRef = useCallback((node) => {
    viewportRef.current = node;
    if (node) {
      measureViewport(node);
    }
  }, [measureViewport]);

  const getCurrentStageMetrics = useCallback(() => (
    getStageMetrics({
      naturalSize: naturalSizeRef.current,
      viewportRect: viewportRectRef.current,
      useLayoutZoomViewer,
      fitScaleLimit,
    })
  ), [fitScaleLimit, useLayoutZoomViewer]);

  const commitNaturalSize = useCallback((width, height) => {
    if (width <= 0 || height <= 0) {
      return false;
    }

    const nextSize = { width, height };
    naturalSizeRef.current = nextSize;
    setImageLoadError('');
    setNaturalSize((current) => (
      current.width === width && current.height === height
        ? current
        : nextSize
    ));
    measureViewport();
    return true;
  }, [measureViewport]);

  const commitNaturalSizeFromImage = useCallback((image) => {
    if (!image) {
      return false;
    }
    return commitNaturalSize(image.naturalWidth, image.naturalHeight);
  }, [commitNaturalSize]);

  const handleImageLoad = useCallback((event) => {
    commitNaturalSizeFromImage(event.currentTarget);
  }, [commitNaturalSizeFromImage]);

  const handleVideoLoadedMetadata = useCallback((event) => {
    const video = event.currentTarget;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    commitNaturalSize(width, height);
  }, [commitNaturalSize]);

  const handleImageError = useCallback(() => {
    if (isDocAttachment) {
      setImageLoadError('Unable to render this document');
    } else if (isVideoAttachment) {
      setImageLoadError('Unable to play this video');
    } else {
      setImageLoadError('Unable to render this image');
    }
  }, [isDocAttachment, isVideoAttachment]);

  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const resetNaturalSize = useCallback(() => {
    const nextSize = { width: 0, height: 0 };
    naturalSizeRef.current = nextSize;
    setNaturalSize((current) => (
      current.width === 0 && current.height === 0
        ? current
        : nextSize
    ));
  }, []);

  const resetTransform = useCallback(() => {
    const next = { scale: 1, x: 0, y: 0 };
    transformRef.current = next;
    setTransform(next);
  }, []);

  const clampTransform = useCallback((nextTransform, nextScale = nextTransform.scale) => {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const {
      hasStage: currentHasStage,
      stageWidth: currentStageWidth,
      stageHeight: currentStageHeight,
    } = getCurrentStageMetrics();
    const currentViewportRect = viewportRectRef.current;
    if (!currentHasStage || currentViewportRect.width <= 0 || currentViewportRect.height <= 0) {
      return { scale, x: 0, y: 0 };
    }

    const overflowX = Math.max(0, ((currentStageWidth * scale) - currentViewportRect.width) / 2);
    const overflowY = Math.max(0, ((currentStageHeight * scale) - currentViewportRect.height) / 2);

    return {
      scale,
      x: clamp(nextTransform.x, -overflowX, overflowX),
      y: clamp(nextTransform.y, -overflowY, overflowY),
    };
  }, [getCurrentStageMetrics]);

  const clampWebView = useCallback((nextView, nextZoom = nextView.zoom) => {
    const zoom = clamp(nextZoom, MIN_SCALE, MAX_WEB_ZOOM);
    const {
      hasStage: currentHasStage,
      stageWidth: currentStageWidth,
      stageHeight: currentStageHeight,
    } = getCurrentStageMetrics();
    const currentViewportRect = viewportRectRef.current;
    if (!currentHasStage || currentViewportRect.width <= 0 || currentViewportRect.height <= 0) {
      return { zoom, x: 0, y: 0 };
    }

    const overflowX = Math.max(0, ((currentStageWidth * zoom) - currentViewportRect.width) / 2);
    const overflowY = Math.max(0, ((currentStageHeight * zoom) - currentViewportRect.height) / 2);

    return {
      zoom,
      x: clamp(nextView.x, -overflowX, overflowX),
      y: clamp(nextView.y, -overflowY, overflowY),
    };
  }, [getCurrentStageMetrics]);

  const commitTransform = useCallback((nextTransform) => {
    const clamped = clampTransform(nextTransform, nextTransform.scale);
    transformRef.current = clamped;
    setTransform(clamped);
    return clamped;
  }, [clampTransform]);

  const scheduleWebViewCommit = useCallback((nextView, options = {}) => {
    const { immediate = false } = options;
    const clamped = clampWebView(nextView, nextView.zoom);
    webViewRef.current = clamped;

    if (immediate) {
      if (webViewFrameRef.current) {
        cancelAnimationFrame(webViewFrameRef.current);
        webViewFrameRef.current = 0;
      }
      webPendingViewRef.current = null;
      setWebView(clamped);
      return clamped;
    }

    webPendingViewRef.current = clamped;
    if (!webViewFrameRef.current) {
      webViewFrameRef.current = requestAnimationFrame(() => {
        webViewFrameRef.current = 0;
        if (!webPendingViewRef.current) {
          return;
        }
        setWebView(webPendingViewRef.current);
        webPendingViewRef.current = null;
      });
    }

    return clamped;
  }, [clampWebView]);

  const resetWebView = useCallback(() => {
    scheduleWebViewCommit({ zoom: 1, x: 0, y: 0 }, { immediate: true });
  }, [scheduleWebViewCommit]);

  const zoomAtPoint = useCallback((nextScale, anchorClientPoint) => {
    const {
      hasStage: currentHasStage,
    } = getCurrentStageMetrics();
    const currentViewportRect = viewportRectRef.current;
    if (!currentHasStage) {
      return;
    }

    const current = transformRef.current;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(scale - current.scale) < 0.001) {
      return;
    }

    const anchor = {
      x: anchorClientPoint.x - currentViewportRect.left,
      y: anchorClientPoint.y - currentViewportRect.top,
    };
    const viewportCenter = {
      x: currentViewportRect.width / 2,
      y: currentViewportRect.height / 2,
    };
    const anchorDx = anchor.x - viewportCenter.x;
    const anchorDy = anchor.y - viewportCenter.y;
    const ratio = scale / current.scale;

    commitTransform({
      scale,
      x: anchorDx - ((anchorDx - current.x) * ratio),
      y: anchorDy - ((anchorDy - current.y) * ratio),
    });
  }, [commitTransform, getCurrentStageMetrics]);

  const zoomWebAtPoint = useCallback((nextZoom, anchorClientPoint) => {
    const {
      hasStage: currentHasStage,
    } = getCurrentStageMetrics();
    const currentViewportRect = viewportRectRef.current;
    if (!useLayoutZoomViewer || !currentHasStage) {
      return webViewRef.current;
    }

    const current = webViewRef.current;
    const zoom = clamp(nextZoom, MIN_SCALE, MAX_WEB_ZOOM);
    if (Math.abs(zoom - current.zoom) < WEB_ZOOM_EPSILON) {
      return current;
    }

    const anchor = {
      x: anchorClientPoint.x - currentViewportRect.left,
      y: anchorClientPoint.y - currentViewportRect.top,
    };
    const viewportCenter = {
      x: currentViewportRect.width / 2,
      y: currentViewportRect.height / 2,
    };
    const anchorDx = anchor.x - viewportCenter.x;
    const anchorDy = anchor.y - viewportCenter.y;
    const ratio = zoom / current.zoom;

    return scheduleWebViewCommit({
      zoom,
      x: anchorDx - ((anchorDx - current.x) * ratio),
      y: anchorDy - ((anchorDy - current.y) * ratio),
    });
  }, [getCurrentStageMetrics, scheduleWebViewCommit, useLayoutZoomViewer]);

  const clearPointers = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = { mode: 'idle' };
  }, []);

  const goPrev = useCallback(() => {
    setActiveIndex((current) => Math.max(0, current - 1));
  }, []);

  const goNext = useCallback(() => {
    setActiveIndex((current) => Math.min(attachmentCount - 1, current + 1));
  }, [attachmentCount]);

  const navigateBySwipe = useCallback((dx, dy, durationMs) => {
    if (webViewRef.current.zoom > (MIN_SCALE + WEB_ZOOM_EPSILON)) {
      return false;
    }

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const velocity = absDx / Math.max(durationMs, 1);
    const isHorizontal = absDx > (absDy * 1.5);
    const hasDistance = absDx >= SWIPE_NAV_DISTANCE;
    const hasMomentum = velocity >= SWIPE_NAV_VELOCITY || absDx >= SWIPE_NAV_LONG_DISTANCE;
    const withinVerticalDrift = absDy <= SWIPE_NAV_VERTICAL_DRIFT;

    if (!isHorizontal || !hasDistance || !hasMomentum || !withinVerticalDrift) {
      return false;
    }

    if (dx < 0 && hasNext) {
      goNext();
      return true;
    }

    if (dx > 0 && hasPrev) {
      goPrev();
      return true;
    }

    return false;
  }, [goNext, goPrev, hasNext, hasPrev]);

  const retryFetch = useCallback(async () => {
    if (!canFetch || !activeAttachment) {
      return;
    }

    try {
      await onRequestAttachment?.({ attachment: activeAttachment, externalRef });
    } catch (error) {
      console.warn('[CHAT] Failed to fetch attachment bytes:', error.message);
    }
  }, [activeAttachment, canFetch, externalRef, onRequestAttachment]);

  const updateAnnotations = useCallback((updater) => {
    if (!annotationKey) {
      return;
    }

    setAnnotationState((prev) => {
      const current = prev[annotationKey] || EMPTY_ANNOTATIONS;
      const next = updater(current);
      if (!next) {
        return prev;
      }
      return {
        ...prev,
        [annotationKey]: next,
      };
    });
  }, [annotationKey]);

  const undoStroke = useCallback(() => {
    updateAnnotations((current) => {
      if (!current.strokes.length) {
        return current;
      }

      return {
        strokes: current.strokes.slice(0, -1),
        redo: [...current.redo, current.strokes[current.strokes.length - 1]],
      };
    });
  }, [updateAnnotations]);

  const redoStroke = useCallback(() => {
    updateAnnotations((current) => {
      if (!current.redo.length) {
        return current;
      }

      return {
        strokes: [...current.strokes, current.redo[current.redo.length - 1]],
        redo: current.redo.slice(0, -1),
      };
    });
  }, [updateAnnotations]);

  const clearAnnotations = useCallback(() => {
    if (!hasAnnotations) {
      return;
    }

    if (typeof window !== 'undefined' && !window.confirm('Clear all annotations on this image?')) {
      return;
    }

    updateAnnotations(() => ({ strokes: [], redo: [] }));
  }, [hasAnnotations, updateAnnotations]);

  const sendAnnotatedImage = useCallback(async () => {
    if (!canSendAnnotated || !imageRef.current) {
      return;
    }

    setSendError('');
    setIsSending(true);

    try {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = naturalSize.width;
      exportCanvas.height = naturalSize.height;

      const ctx = exportCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas unavailable');
      }

      ctx.drawImage(imageRef.current, 0, 0, naturalSize.width, naturalSize.height);
      for (const stroke of strokes) {
        drawStroke(ctx, stroke, 1);
      }

      const blob = await canvasToBlob(exportCanvas);
      const filename = buildAnnotatedFileName(activeAttachment?.name);
      const file = new File([blob], filename, {
        type: 'image/png',
        lastModified: Date.now(),
      });

      await annotatedAttachmentHandler?.(file);
      onClose?.();
      return;
    } catch (error) {
      setSendError(error?.message || 'Failed to send annotated image');
      setIsSending(false);
    }
  }, [activeAttachment?.name, annotatedAttachmentHandler, canSendAnnotated, naturalSize.height, naturalSize.width, onClose, strokes]);

  const handleDownload = useCallback(async () => {
    // Always read bytes from the resolved attachment — fetched-on-demand
    // bytes live in the cache, not on the original metadata object.
    const source = resolvedAttachment || activeAttachment;
    if (!source) {
      return;
    }
    if (!source.bytesBase64) {
      setSendError('Attachment data unavailable.');
      return;
    }
    const filename = source.name || 'attachment';
    const mime = source.mime || 'application/octet-stream';
    const canShareFiles = (
      typeof navigator !== 'undefined'
      && typeof navigator.canShare === 'function'
      && typeof navigator.share === 'function'
    );
    try {
      // Decode base64 directly into a Blob. Avoids fetch() on a data: URL,
      // which is blocked by the production connect-src policy.
      const binaryString = atob(source.bytesBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mime });

      // On iOS PWAs and mobile Safari, `<a download>` is unreliable — it often
      // opens the file in a new webview tab instead of presenting a save
      // dialog. The Web Share API with a File is the supported path: it
      // presents the native share sheet (Save to Files, AirDrop, etc.).
      //
      // When file-share is supported on the device we treat the share sheet as
      // the only valid save path. Any rejection or failure surfaces an error
      // rather than falling back to the broken anchor-download path on iOS.
      if (canShareFiles) {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        if (!navigator.canShare({ files: [file] })) {
          setSendError('This file type is not supported by the system share sheet.');
          return;
        }
        try {
          await navigator.share({ files: [file], title: filename });
          return;
        } catch (shareError) {
          if (shareError?.name === 'AbortError') {
            // User dismissed the share sheet — treat as a quiet cancel.
            return;
          }
          setSendError(shareError?.message || 'Unable to save file. Try again or long-press the attachment.');
          return;
        }
      }

      // Desktop / browsers without file-share support: blob URL + download attr.
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setSendError(error?.message || 'Unable to download attachment.');
    }
  }, [resolvedAttachment]);

  useEffect(() => {
    setActiveIndex(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, []);

  // Track text selection inside the doc container so we can offer an
  // "Add comment" floating pill above the selection. Only active when a doc
  // attachment is rendered and the chat-side annotation handler is wired.
  useEffect(() => {
    if (!isDocAttachment || !previewSrc || typeof onSendDocAnnotation !== 'function') {
      setDocSelection(null);
      return undefined;
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }
    let frame = 0;
    const compute = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setDocSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = docContainerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setDocSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setDocSelection(null);
        return;
      }
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setDocSelection(null);
        return;
      }
      // Clone the range now while the doc still owns the selection — iOS
      // moves focus to the textarea once the sheet opens and would clear it.
      let cloned = null;
      try { cloned = range.cloneRange(); } catch {}
      setDocSelection({
        text,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        range: cloned,
      });
    };
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(compute);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [isDocAttachment, previewSrc, onSendDocAnnotation]);

  // Recompute highlight rectangles on viewport resize and orientation change
  // so existing annotations stay aligned with their text after reflow.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const bump = () => setHighlightTick((tick) => tick + 1);
    window.addEventListener('resize', bump);
    window.addEventListener('orientationchange', bump);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('orientationchange', bump);
    };
  }, []);

  // Compute highlight rectangles for each queued annotation, transformed into
  // coordinates relative to the scrolling content wrapper so they scroll
  // naturally with the doc. Returns rects + per-annotation icon anchor.
  const highlightInfo = useMemo(() => {
    void highlightTick;
    if (!isDocAttachment || docAnnotationQueue.length === 0) return { rects: [], markers: [] };
    const content = docContentNode;
    const container = docContainerRef.current;
    if (!content || !container) return { rects: [], markers: [] };
    const contentRect = content.getBoundingClientRect();
    const rects = [];
    const markers = [];
    for (const entry of docAnnotationQueue) {
      if (!entry.range) continue;
      try {
        const clientRects = entry.range.getClientRects();
        let lastRect = null;
        for (let i = 0; i < clientRects.length; i += 1) {
          const r = clientRects[i];
          if (r.width === 0 && r.height === 0) continue;
          rects.push({
            id: `${entry.id}_${i}`,
            top: r.top - contentRect.top,
            left: r.left - contentRect.left,
            width: r.width,
            height: r.height,
          });
          lastRect = r;
        }
        if (lastRect) {
          markers.push({
            id: entry.id,
            top: lastRect.top - contentRect.top + lastRect.height / 2 - 11,
            left: lastRect.right - contentRect.left + 4,
          });
        }
      } catch {
        // Range invalidated (DOM changed) — skip.
      }
    }
    return { rects, markers };
  }, [docAnnotationQueue, highlightTick, isDocAttachment, docContentNode]);
  const highlightRects = highlightInfo.rects;
  const highlightMarkers = highlightInfo.markers;

  // Reset annotation UI when switching attachments.
  useEffect(() => {
    setDocSelection(null);
    setDocCommentSheet(null);
    setDocCommentDraft('');
    setDocAnnotationError('');
    setDocAnnotationSending(false);
    setDocAnnotationQueue([]);
  }, [activeAttachment?.id]);

  const openDocCommentSheet = useCallback(() => {
    if (!docSelection) return;
    setDocCommentSheet({ selection: docSelection });
    setDocCommentDraft('');
    setDocAnnotationError('');
  }, [docSelection]);

  const closeDocCommentSheet = useCallback(() => {
    setDocCommentSheet(null);
    setDocCommentDraft('');
    setDocAnnotationError('');
    setDocSheetDragY(0);
    docSheetDragRef.current = { active: false, startY: 0, lastY: 0 };
  }, []);

  const handleSheetDragStart = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    docSheetDragRef.current = { active: true, startY: event.clientY, lastY: event.clientY };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch {}
  }, []);

  const handleSheetDragMove = useCallback((event) => {
    if (!docSheetDragRef.current.active) return;
    const dy = event.clientY - docSheetDragRef.current.startY;
    docSheetDragRef.current.lastY = event.clientY;
    setDocSheetDragY(Math.max(0, dy));
  }, []);

  const handleSheetDragEnd = useCallback((event) => {
    if (!docSheetDragRef.current.active) return;
    const dy = event.clientY - docSheetDragRef.current.startY;
    docSheetDragRef.current.active = false;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
    if (dy > 80) {
      closeDocCommentSheet();
    } else {
      setDocSheetDragY(0);
    }
  }, [closeDocCommentSheet]);

  const queueDocAnnotation = useCallback(() => {
    if (!docCommentSheet) return;
    const comment = docCommentDraft.trim();
    if (!comment) return;
    const quoted = docCommentSheet.selection?.text || '';
    const truncated = quoted.length > 240 ? `${quoted.slice(0, 240).trim()}…` : quoted;
    const savedRange = docCommentSheet.selection?.range || null;
    setDocAnnotationQueue((prev) => [
      ...prev,
      {
        id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        quote: truncated.replace(/\n+/g, ' '),
        comment,
        range: savedRange,
      },
    ]);
    setDocCommentSheet(null);
    setDocCommentDraft('');
    setDocAnnotationError('');
    try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
    setDocSelection(null);
  }, [docCommentSheet, docCommentDraft]);

  const sendDocAnnotationQueue = useCallback(async () => {
    if (typeof onSendDocAnnotation !== 'function' || docAnnotationQueue.length === 0) return;
    const filename = activeAttachment?.name || 'document';
    setDocAnnotationSending(true);
    setDocAnnotationError('');
    try {
      // Send a typed payload so the server validates structure and never
      // sees free-form chat text crafted by the user. The server renders
      // the canonical "📝 Annotation on filename" message from these
      // fields after schema validation.
      const items = docAnnotationQueue.map((entry) => ({
        quote: entry.quote,
        comment: entry.comment,
      }));
      await onSendDocAnnotation({ filename, items });
      setDocAnnotationQueue([]);
      onClose?.();
    } catch (err) {
      setDocAnnotationError(err?.message || 'Could not send annotations');
    } finally {
      setDocAnnotationSending(false);
    }
  }, [docAnnotationQueue, onSendDocAnnotation, activeAttachment?.name, onClose]);

  const removeQueuedAnnotation = useCallback((index) => {
    setDocAnnotationQueue((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const openExistingAnnotation = useCallback((annotationId) => {
    const entry = docAnnotationQueue.find((item) => item.id === annotationId);
    if (!entry) return;
    setDocCommentSheet({
      selection: { text: entry.quote, range: entry.range || null },
      editingId: annotationId,
    });
    setDocCommentDraft(entry.comment || '');
    setDocAnnotationError('');
  }, [docAnnotationQueue]);

  // Live ref to the latest openExistingAnnotation so DOM-attached click
  // handlers always call the freshest callback even when queue updates.
  const openExistingAnnotationRef = useRef(openExistingAnnotation);
  useEffect(() => {
    openExistingAnnotationRef.current = openExistingAnnotation;
  }, [openExistingAnnotation]);

  // Marker insertion + heal lifecycle is owned by the keyed <DocBody>
  // child below. When the doc attachment swaps, DocBody unmounts and its
  // heal runs synchronously inside its own commit, before React can
  // reconcile any new content into the same subtree.

  const updateExistingAnnotation = useCallback(() => {
    if (!docCommentSheet?.editingId) return;
    const comment = docCommentDraft.trim();
    if (!comment) return;
    const editingId = docCommentSheet.editingId;
    setDocAnnotationQueue((prev) => prev.map((item) => (
      item.id === editingId ? { ...item, comment } : item
    )));
    setDocCommentSheet(null);
    setDocCommentDraft('');
    setDocAnnotationError('');
  }, [docCommentSheet, docCommentDraft]);

  const deleteExistingAnnotation = useCallback(() => {
    if (!docCommentSheet?.editingId) return;
    const editingId = docCommentSheet.editingId;
    setDocAnnotationQueue((prev) => prev.filter((item) => item.id !== editingId));
    setDocCommentSheet(null);
    setDocCommentDraft('');
    setDocAnnotationError('');
  }, [docCommentSheet]);

  useLayoutEffect(() => {
    measureViewport();

    window.addEventListener('resize', measureViewport);
    window.addEventListener('orientationchange', measureViewport);
    return () => {
      window.removeEventListener('resize', measureViewport);
      window.removeEventListener('orientationchange', measureViewport);
    };
  }, [measureViewport]);

  useLayoutEffect(() => {
    setImageLoadError('');
    setSendError('');
    setIsSending(false);
    clearPointers();
    resetNaturalSize();
    measureViewport();
    if (useLayoutZoomViewer) {
      resetWebView();
      return;
    }
    resetTransform();
  }, [activeAttachment?.id, clearPointers, measureViewport, resetNaturalSize, resetTransform, resetWebView, useLayoutZoomViewer]);

  useEffect(() => {
    if (!previewSrc || hasNaturalSize) {
      return;
    }

    const image = imageRef.current;
    if (!image) {
      return undefined;
    }

    let cancelled = false;
    const commitFromImage = () => {
      if (cancelled) {
        return false;
      }
      return commitNaturalSizeFromImage(image);
    };

    const handleLoad = () => {
      commitFromImage();
    };

    image.addEventListener('load', handleLoad);

    if (!commitFromImage()) {
      if (typeof image.decode === 'function') {
        image.decode()
          .then(() => {
            commitFromImage();
          })
          .catch(() => {
            if (image.complete) {
              commitFromImage();
            }
          });
      } else if (image.complete) {
        commitFromImage();
      }
    }

    return () => {
      cancelled = true;
      image.removeEventListener('load', handleLoad);
    };
  }, [commitNaturalSizeFromImage, hasNaturalSize, previewSrc]);

  useLayoutEffect(() => {
    if (viewportRect.width <= 0 || viewportRect.height <= 0) {
      return;
    }
    clearPointers();
    if (useLayoutZoomViewer) {
      resetWebView();
      return;
    }
    resetTransform();
  }, [clearPointers, resetTransform, resetWebView, useLayoutZoomViewer, viewportRect.height, viewportRect.width]);

  useEffect(() => {
    if (!activeAttachment || previewSrc || !canFetch || isLoading || fetchError) {
      return;
    }

    onRequestAttachment?.({ attachment: activeAttachment, externalRef }).catch((error) => {
      console.warn('[CHAT] Failed to fetch attachment bytes:', error.message);
    });
  }, [activeAttachment, canFetch, externalRef, fetchError, isLoading, onRequestAttachment, previewSrc]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasStage || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return;
    }

    const renderWidth = Math.max(1, Math.round(useLayoutZoomViewer ? stageDisplayWidth : stageWidth));
    const renderHeight = Math.max(1, Math.round(useLayoutZoomViewer ? stageDisplayHeight : stageHeight));
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(renderWidth * devicePixelRatio) || canvas.height !== Math.round(renderHeight * devicePixelRatio)) {
      canvas.width = Math.round(renderWidth * devicePixelRatio);
      canvas.height = Math.round(renderHeight * devicePixelRatio);
    }

    canvas.style.width = `${renderWidth}px`;
    canvas.style.height = `${renderHeight}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, renderWidth, renderHeight);

    const previewScale = renderWidth / naturalSize.width;
    for (const stroke of strokes) {
      drawStroke(ctx, stroke, previewScale);
    }

    if (draftStrokeRef.current) {
      drawStroke(ctx, draftStrokeRef.current, previewScale);
    }
  }, [hasStage, naturalSize.height, naturalSize.width, stageDisplayHeight, stageDisplayWidth, stageHeight, stageWidth, strokes, useLayoutZoomViewer]);

  const scheduleCanvasRender = useCallback(() => {
    if (renderFrameRef.current) {
      return;
    }

    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      renderCanvas();
    });
  }, [renderCanvas]);

  useEffect(() => {
    renderCanvas();

    return () => {
      if (renderFrameRef.current) {
        cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = 0;
      }
    };
  }, [renderCanvas]);

  useEffect(() => {
    return () => {
      if (webViewFrameRef.current) {
        cancelAnimationFrame(webViewFrameRef.current);
        webViewFrameRef.current = 0;
      }
    };
  }, []);

  useEffect(() => {
    drawingPointerIdRef.current = null;
    draftStrokeRef.current = null;
    scheduleCanvasRender();
  }, [annotationKey, scheduleCanvasRender]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const isModifierPressed = event.metaKey || event.ctrlKey;
      const lowerKey = event.key.toLowerCase();

      if (isModifierPressed && lowerKey === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          redoStroke();
          return;
        }
        undoStroke();
        return;
      }

      if (event.ctrlKey && lowerKey === 'y') {
        event.preventDefault();
        redoStroke();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }

      if (event.key === 'ArrowLeft' && hasPrev) {
        event.preventDefault();
        goPrev();
        return;
      }

      if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        goNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goNext, goPrev, hasNext, hasPrev, onClose, redoStroke, undoStroke]);

  const commitDraftStroke = useCallback(() => {
    const draft = draftStrokeRef.current;
    draftStrokeRef.current = null;
    drawingPointerIdRef.current = null;

    if (!draft || !draft.points.length) {
      scheduleCanvasRender();
      return;
    }

    updateAnnotations((current) => ({
      strokes: [...current.strokes, {
        color: draft.color,
        width: draft.width,
        points: [...draft.points],
      }],
      redo: [],
    }));
  }, [scheduleCanvasRender, updateAnnotations]);

  const handleDrawPointerDown = useCallback((event) => {
    if (!drawEnabled || !previewSrc || !hasStage || !hasNaturalSize) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const stageRect = contentRef.current?.getBoundingClientRect();

    const point = getImagePointFromClient({
      clientX: event.clientX,
      clientY: event.clientY,
      stageRect,
      naturalWidth: naturalSize.width,
      naturalHeight: naturalSize.height,
    });

    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const naturalStrokeWidth = selectedWidth * (naturalSize.width / stageWidth);
    drawingPointerIdRef.current = event.pointerId;
    draftStrokeRef.current = {
      color: selectedColor,
      width: naturalStrokeWidth,
      points: [point],
    };
    scheduleCanvasRender();
  }, [drawEnabled, hasNaturalSize, hasStage, naturalSize.height, naturalSize.width, previewSrc, scheduleCanvasRender, selectedColor, selectedWidth, stageWidth]);

  const handleDrawPointerMove = useCallback((event) => {
    if (drawingPointerIdRef.current !== event.pointerId || !draftStrokeRef.current) {
      return;
    }

    const stageRect = contentRef.current?.getBoundingClientRect();

    const point = getImagePointFromClient({
      clientX: event.clientX,
      clientY: event.clientY,
      stageRect,
      naturalWidth: naturalSize.width,
      naturalHeight: naturalSize.height,
    });

    if (!point) {
      return;
    }

    const points = draftStrokeRef.current.points;
    const lastPoint = points[points.length - 1];
    if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 0.5) {
      return;
    }

    points.push(point);
    scheduleCanvasRender();
  }, [naturalSize.height, naturalSize.width, scheduleCanvasRender]);

  const handleDrawPointerUp = useCallback((event) => {
    if (drawingPointerIdRef.current !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commitDraftStroke();
  }, [commitDraftStroke]);

  const handleDrawPointerCancel = useCallback((event) => {
    if (drawingPointerIdRef.current !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    draftStrokeRef.current = null;
    drawingPointerIdRef.current = null;
    scheduleCanvasRender();
  }, [scheduleCanvasRender]);

  const handleWheel = useCallback((event) => {
    if (!hasStage || useLayoutZoomViewer) {
      return;
    }

    event.preventDefault();
    const scaleDelta = Math.exp(-event.deltaY * 0.0025);
    zoomAtPoint(transformRef.current.scale * scaleDelta, {
      x: event.clientX,
      y: event.clientY,
    });
  }, [hasStage, useLayoutZoomViewer, zoomAtPoint]);

  const handleWebWheel = useCallback((event) => {
    if (!useLayoutZoomViewer || !hasStage || drawEnabled || !previewSrc) {
      return;
    }

    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    const scaleDelta = Math.exp(-event.deltaY * 0.0025);
    zoomWebAtPoint(webViewRef.current.zoom * scaleDelta, {
      x: event.clientX,
      y: event.clientY,
    });
  }, [drawEnabled, hasStage, previewSrc, useLayoutZoomViewer, zoomWebAtPoint]);

  const handleStagePointerDown = useCallback((event) => {
    if (drawEnabled) {
      return;
    }
    if (!previewSrc) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    measureViewport();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      tapStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
    } else {
      tapStartRef.current = null;
    }

    if (pointersRef.current.size >= 2) {
      const [pointA, pointB] = Array.from(pointersRef.current.values());
      gestureRef.current = {
        mode: 'pinch',
        pinch: getViewportPoint(pointA, pointB),
      };
      return;
    }

    gestureRef.current = {
      mode: 'pan',
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
  }, [drawEnabled, measureViewport, previewSrc]);

  const handleWebStagePointerDown = useCallback((event) => {
    if (!useLayoutZoomViewer || drawEnabled || !previewSrc) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    measureViewport(event.currentTarget);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      tapStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
    } else {
      tapStartRef.current = null;
    }

    if (pointersRef.current.size >= 2) {
      const [pointA, pointB] = Array.from(pointersRef.current.values());
      gestureRef.current = {
        mode: 'web-pinch',
        pinch: getViewportPoint(pointA, pointB),
      };
      return;
    }

    if (webViewRef.current.zoom > (MIN_SCALE + WEB_ZOOM_EPSILON)) {
      gestureRef.current = {
        mode: 'web-pan',
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      return;
    }

    gestureRef.current = event.pointerType === 'mouse'
      ? { mode: 'idle' }
      : {
          mode: 'web-swipe',
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          startTime: event.timeStamp,
          lastTime: event.timeStamp,
        };
  }, [drawEnabled, measureViewport, previewSrc, useLayoutZoomViewer]);

  const handleStagePointerMove = useCallback((event) => {
    if (drawEnabled) {
      return;
    }
    if (!pointersRef.current.has(event.pointerId)) {
      return;
    }

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      const [pointA, pointB] = Array.from(pointersRef.current.values());
      const nextPinch = getViewportPoint(pointA, pointB);
      const previousPinch = gestureRef.current.mode === 'pinch' ? gestureRef.current.pinch : nextPinch;

      const nextScale = transformRef.current.scale * (nextPinch.distance / Math.max(previousPinch.distance, 1));
      zoomAtPoint(nextScale, nextPinch.center);

      const current = transformRef.current;
      commitTransform({
        scale: current.scale,
        x: current.x + (nextPinch.center.x - previousPinch.center.x),
        y: current.y + (nextPinch.center.y - previousPinch.center.y),
      });

      gestureRef.current = {
        mode: 'pinch',
        pinch: nextPinch,
      };
      return;
    }

    if (gestureRef.current.mode !== 'pan' || gestureRef.current.pointerId !== event.pointerId) {
      return;
    }

    const current = transformRef.current;
    if (current.scale <= 1) {
      gestureRef.current = {
        ...gestureRef.current,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      return;
    }

    commitTransform({
      scale: current.scale,
      x: current.x + (event.clientX - gestureRef.current.lastX),
      y: current.y + (event.clientY - gestureRef.current.lastY),
    });

    gestureRef.current = {
      ...gestureRef.current,
      lastX: event.clientX,
      lastY: event.clientY,
    };
  }, [commitTransform, drawEnabled, zoomAtPoint]);

  const handleWebStagePointerMove = useCallback((event) => {
    if (!useLayoutZoomViewer || drawEnabled || !pointersRef.current.has(event.pointerId)) {
      return;
    }

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      event.preventDefault();
      const [pointA, pointB] = Array.from(pointersRef.current.values());
      const nextPinch = getViewportPoint(pointA, pointB);
      const previousPinch = gestureRef.current.mode === 'web-pinch' ? gestureRef.current.pinch : nextPinch;
      const currentView = webViewRef.current;
      const nextZoom = currentView.zoom * (nextPinch.distance / Math.max(previousPinch.distance, 1));
      const zoomedView = zoomWebAtPoint(nextZoom, nextPinch.center);

      scheduleWebViewCommit({
        zoom: zoomedView.zoom,
        x: zoomedView.x + (nextPinch.center.x - previousPinch.center.x),
        y: zoomedView.y + (nextPinch.center.y - previousPinch.center.y),
      });

      gestureRef.current = {
        mode: 'web-pinch',
        pinch: nextPinch,
      };
      return;
    }

    if (gestureRef.current.mode === 'web-pan' && gestureRef.current.pointerId === event.pointerId) {
      event.preventDefault();
      scheduleWebViewCommit({
        zoom: webViewRef.current.zoom,
        x: webViewRef.current.x + (event.clientX - gestureRef.current.lastX),
        y: webViewRef.current.y + (event.clientY - gestureRef.current.lastY),
      });

      gestureRef.current = {
        ...gestureRef.current,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      return;
    }

    if (gestureRef.current.mode === 'web-swipe' && gestureRef.current.pointerId === event.pointerId) {
      gestureRef.current = {
        ...gestureRef.current,
        lastX: event.clientX,
        lastY: event.clientY,
        lastTime: event.timeStamp,
      };
    }
  }, [drawEnabled, scheduleWebViewCommit, useLayoutZoomViewer, zoomWebAtPoint]);

  const releasePointer = useCallback((event) => {
    const tapStart = tapStartRef.current;
    const isTap = (
      tapStart
      && tapStart.pointerId === event.pointerId
      && event.type !== 'pointercancel'
      && Math.abs(event.clientX - tapStart.x) <= TAP_MAX_DISTANCE
      && Math.abs(event.clientY - tapStart.y) <= TAP_MAX_DISTANCE
      && (event.timeStamp - tapStart.time) <= TAP_MAX_DURATION
    );
    if (isTap && isVideoAttachment && videoRef.current) {
      handleVideoClick();
    }
    if (tapStart && tapStart.pointerId === event.pointerId) {
      tapStartRef.current = null;
    }

    if (gestureRef.current.mode === 'web-swipe' && gestureRef.current.pointerId === event.pointerId && event.type !== 'pointercancel') {
      navigateBySwipe(
        event.clientX - gestureRef.current.startX,
        event.clientY - gestureRef.current.startY,
        event.timeStamp - gestureRef.current.startTime
      );
    }

    pointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (useLayoutZoomViewer) {
      if (pointersRef.current.size >= 2) {
        const [pointA, pointB] = Array.from(pointersRef.current.values());
        gestureRef.current = {
          mode: 'web-pinch',
          pinch: getViewportPoint(pointA, pointB),
        };
        return;
      }

      if (pointersRef.current.size === 1) {
        const [[pointerId, point]] = Array.from(pointersRef.current.entries());
        if (webViewRef.current.zoom > (MIN_SCALE + WEB_ZOOM_EPSILON)) {
          gestureRef.current = {
            mode: 'web-pan',
            pointerId,
            lastX: point.x,
            lastY: point.y,
          };
          return;
        }
      }

      gestureRef.current = { mode: 'idle' };
      return;
    }

    if (pointersRef.current.size >= 2) {
      const [pointA, pointB] = Array.from(pointersRef.current.values());
      gestureRef.current = {
        mode: 'pinch',
        pinch: getViewportPoint(pointA, pointB),
      };
      return;
    }

    if (pointersRef.current.size === 1) {
      const [[pointerId, point]] = Array.from(pointersRef.current.entries());
      gestureRef.current = {
        mode: 'pan',
        pointerId,
        lastX: point.x,
        lastY: point.y,
      };
      return;
    }

    gestureRef.current = { mode: 'idle' };
  }, [handleVideoClick, isVideoAttachment, navigateBySwipe, useLayoutZoomViewer]);

  if (typeof document === 'undefined' || attachmentCount === 0 || !activeAttachment) {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment viewer for ${activeAttachment.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.97)',
        paddingTop: 'max(16px, env(safe-area-inset-top))',
        paddingRight: 'max(16px, env(safe-area-inset-right))',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(16px, env(safe-area-inset-left))',
        display: 'flex',
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          position: 'relative',
          paddingBottom: isDocAttachment ? 0 : 92,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              fontSize: 12,
              lineHeight: 1,
              color: 'rgba(255,255,255,0.6)',
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              pointerEvents: 'auto',
            }}
          >
            {activeIndex + 1}/{attachmentCount}
          </span>

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              pointerEvents: 'auto',
            }}
          >
            <button
              type="button"
              onClick={handleDownload}
              aria-label="Download attachment"
              disabled={!previewSrc}
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                border: 'none',
                background: 'transparent',
                color: previewSrc ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.32)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: previewSrc ? 'pointer' : 'not-allowed',
              }}
            >
              <ArrowDownToLine size={16} strokeWidth={2} />
            </button>

            <button
              type="button"
              onClick={() => onClose?.()}
              aria-label="Close attachment viewer"
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                border: 'none',
                background: 'transparent',
                color: 'rgba(255,255,255,0.72)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div
          ref={handleViewportRef}
          onWheel={(event) => {
            handleWheel(event);
            handleWebWheel(event);
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose?.();
            }
          }}
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            background: 'transparent',
            overflow: 'hidden',
            overscrollBehavior: useLayoutZoomViewer ? 'none' : 'auto',
            touchAction: useLayoutZoomViewer ? 'none' : 'pinch-zoom',
          }}
        >
          {(isLoading || (previewSrc && !isDocAttachment && naturalSize.width === 0 && !errorMessage) || (!previewSrc && !errorMessage)) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                color: 'rgba(255,255,255,0.68)',
              }}
            >
              <Loader size={22} strokeWidth={2.2} className="animate-spin" />
              <span style={{ fontSize: 13 }}>{isDocAttachment ? 'Loading document...' : isVideoAttachment ? 'Loading video...' : 'Loading image...'}</span>
            </div>
          )}

          {!isLoading && errorMessage && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                padding: 24,
                textAlign: 'center',
              }}
            >
              <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.72)' }}>
                {errorMessage}
              </span>
              {canFetch && (
                <button
                  type="button"
                  onClick={retryFetch}
                  style={{
                    border: '1px solid rgba(75,90,255,0.28)',
                    background: 'rgba(75,90,255,0.16)',
                    color: '#9ba8ff',
                    borderRadius: 999,
                    padding: '8px 14px',
                    fontSize: 13,
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {previewSrc && isDocAttachment && (
            <div
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  onClose?.();
                }
              }}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                justifyContent: 'center',
                overflow: 'hidden',
                pointerEvents: 'auto',
              }}
            >
              <div
                ref={docContainerRef}
                style={{
                  width: '100%',
                  maxWidth: 720,
                  height: '100%',
                  overflowY: 'auto',
                  WebkitOverflowScrolling: 'touch',
                  padding: '12px 24px 32px',
                  touchAction: 'pan-y pinch-zoom',
                  fontFamily: 'Geist, -apple-system, system-ui, sans-serif',
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                }}
              >
                <DocBody
                  key={annotationKey || 'doc-body'}
                  isMarkdownDoc={isMarkdownDoc}
                  docSource={docSource}
                  docRemarkPlugins={docRemarkPlugins}
                  docMdComponents={docMdComponents}
                  preStyle={{
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: 'rgba(255,255,255,0.85)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: 0,
                  }}
                  annotations={docAnnotationQueue}
                  highlightTick={highlightTick}
                  highlightRects={highlightRects}
                  openAnnotationRef={openExistingAnnotationRef}
                  onContentRefChange={setDocContentNode}
                />
              </div>
            </div>
          )}

          {previewSrc && isDocAttachment && typeof onSendDocAnnotation === 'function' && (() => {
            const pillVisible = !docCommentSheet && (docSelection || docAnnotationQueue.length > 0);
            return (
              <div
                aria-hidden={!pillVisible}
                style={{
                  position: 'fixed',
                  left: 0,
                  right: 0,
                  bottom: 'max(20px, env(safe-area-inset-bottom))',
                  zIndex: 10001,
                  display: 'flex',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                  opacity: pillVisible ? 1 : 0,
                  transform: pillVisible ? 'translateY(0)' : 'translateY(12px)',
                  transition: 'opacity 200ms ease, transform 200ms ease',
                }}
              >
                {docSelection ? (
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={openDocCommentSheet}
                    style={{
                      pointerEvents: pillVisible ? 'auto' : 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      height: 44,
                      padding: '0 20px 0 16px',
                      borderRadius: 999,
                      border: 'none',
                      background: '#4B5AFF',
                      color: '#fff',
                      fontFamily: 'Geist, -apple-system, system-ui, sans-serif',
                      fontSize: 14,
                      fontWeight: 600,
                      letterSpacing: '-0.01em',
                      boxShadow: '0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
                      cursor: 'pointer',
                    }}
                  >
                    <Plus size={16} strokeWidth={2.6} color="#fff" />
                    Add comment
                  </button>
                ) : docAnnotationQueue.length > 0 ? (
                  <button
                    type="button"
                    onClick={sendDocAnnotationQueue}
                    disabled={docAnnotationSending}
                    style={{
                      pointerEvents: pillVisible ? 'auto' : 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 10,
                      height: 44,
                      padding: '0 7px 0 20px',
                      borderRadius: 999,
                      border: 'none',
                      background: '#4B5AFF',
                      color: '#fff',
                      fontFamily: 'Geist, -apple-system, system-ui, sans-serif',
                      fontSize: 14,
                      fontWeight: 600,
                      letterSpacing: '-0.01em',
                      boxShadow: '0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
                      cursor: docAnnotationSending ? 'not-allowed' : 'pointer',
                      opacity: docAnnotationSending ? 0.7 : 1,
                    }}
                  >
                    <span>
                      {docAnnotationQueue.length === 1
                        ? '1 comment'
                        : `${docAnnotationQueue.length} comments`}
                    </span>
                    <span style={{
                      width: 30, height: 30, borderRadius: 999,
                      background: '#fff',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {docAnnotationSending ? (
                        <Loader size={14} strokeWidth={2.6} color="#4B5AFF" className="animate-spin" />
                      ) : (
                        <ArrowUp size={14} strokeWidth={2.6} color="#4B5AFF" />
                      )}
                    </span>
                  </button>
                ) : null}
              </div>
            );
          })()}

          {docCommentSheet && (
            <div
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeDocCommentSheet();
              }}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10002,
                background: 'rgba(0,0,0,0.45)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                padding: 'max(16px, env(safe-area-inset-bottom)) 16px 16px',
              }}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: 560,
                  background: '#111114',
                  borderRadius: 16,
                  paddingTop: 4,
                  paddingRight: 16,
                  paddingBottom: 16,
                  paddingLeft: 16,
                  boxShadow: '0 20px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)',
                  fontFamily: 'Geist, -apple-system, system-ui, sans-serif',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  transform: `translateY(${docSheetDragY}px)`,
                  transition: docSheetDragRef.current.active ? 'none' : 'transform 200ms ease',
                }}
              >
                <div
                  onPointerDown={handleSheetDragStart}
                  onPointerMove={handleSheetDragMove}
                  onPointerUp={handleSheetDragEnd}
                  onPointerCancel={handleSheetDragEnd}
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    paddingTop: 6,
                    paddingBottom: 6,
                    cursor: 'grab',
                    touchAction: 'none',
                  }}
                >
                  <div style={{
                    width: 36,
                    height: 4,
                    borderRadius: 2,
                    background: 'rgba(255,255,255,0.18)',
                  }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
                    {docCommentSheet?.editingId ? 'Edit annotation' : 'Annotation'}
                  </span>
                  <button
                    type="button"
                    onClick={closeDocCommentSheet}
                    aria-label="Cancel annotation"
                    style={{
                      width: 28, height: 28, borderRadius: 999, border: 'none',
                      background: 'transparent', color: 'rgba(255,255,255,0.6)',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}
                  >
                    <X size={16} strokeWidth={2} />
                  </button>
                </div>
                <div
                  style={{
                    fontSize: 15,
                    lineHeight: 1.45,
                    color: '#fff',
                    background: '#4B5AFF',
                    border: 'none',
                    padding: 12,
                    borderRadius: 8,
                    maxHeight: 120,
                    overflowY: 'auto',
                  }}
                >
                  {docCommentSheet.selection?.text}
                </div>
                <textarea
                  autoFocus
                  value={docCommentDraft}
                  onChange={(event) => setDocCommentDraft(event.target.value)}
                  placeholder="Your comment…"
                  rows={3}
                  style={{
                    width: '100%',
                    resize: 'none',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    padding: 12,
                    fontFamily: 'inherit',
                    fontSize: 15,
                    lineHeight: 1.45,
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                {docAnnotationError && (
                  <span style={{ fontSize: 12, color: '#ff8a8a' }}>{docAnnotationError}</span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {docCommentSheet?.editingId && (
                    <button
                      type="button"
                      onClick={deleteExistingAnnotation}
                      aria-label="Delete annotation"
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        border: 'none',
                        background: 'rgba(255,255,255,0.06)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2} color="rgba(255,255,255,0.7)" />
                    </button>
                  )}
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    onClick={closeDocCommentSheet}
                    disabled={docAnnotationSending}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 999,
                      border: 'none',
                      background: 'transparent',
                      color: 'rgba(255,255,255,0.6)',
                      fontSize: 13,
                      cursor: docAnnotationSending ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={docCommentSheet?.editingId ? updateExistingAnnotation : queueDocAnnotation}
                    disabled={!docCommentDraft.trim()}
                    aria-label={docCommentSheet?.editingId ? 'Update annotation' : 'Add annotation'}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      border: 'none',
                      background: docCommentDraft.trim() ? '#4B5AFF' : 'rgba(255,255,255,0.1)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: docCommentDraft.trim() ? 'pointer' : 'default',
                      transition: 'background 0.15s',
                    }}
                  >
                    {docCommentSheet?.editingId ? (
                      <ArrowUp size={16} strokeWidth={2.6} color="#fff" />
                    ) : (
                      <Plus size={16} strokeWidth={2.6} color="#fff" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {previewSrc && !isDocAttachment && (
            useLayoutZoomViewer ? (
              <div
                onPointerDown={handleWebStagePointerDown}
                onPointerMove={handleWebStagePointerMove}
                onPointerUp={releasePointer}
                onPointerCancel={releasePointer}
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) {
                    onClose?.();
                  }
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  touchAction: 'none',
                }}
              >
                <div
                  ref={contentRef}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: hasStage ? stageDisplayWidth : '100%',
                    height: hasStage ? stageDisplayHeight : '100%',
                    transform: `translate(-50%, -50%) translate3d(${webView.x}px, ${webView.y}px, 0)`,
                    willChange: 'transform,width,height',
                    touchAction: 'none',
                    cursor: drawEnabled ? 'crosshair' : (webView.zoom > 1 ? 'grab' : 'default'),
                  }}
                >
                  {isVideoAttachment ? (
                    <video
                      ref={videoRef}
                      key={previewSrc}
                      src={previewSrc}
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={handleVideoLoadedMetadata}
                      onError={handleImageError}
                      style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        borderRadius: 12,
                        background: '#000',
                        outline: 'none',
                        boxShadow: '0 24px 60px rgba(0,0,0,0.48)',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                        touchAction: 'none',
                        cursor: 'pointer',
                      }}
                    />
                  ) : (
                    <img
                      ref={imageRef}
                      src={previewSrc}
                      alt={activeAttachment.name}
                      onLoad={handleImageLoad}
                      onError={handleImageError}
                      style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                        pointerEvents: 'none',
                        touchAction: 'none',
                      }}
                      draggable={false}
                    />
                  )}
                  {!isVideoAttachment && hasNaturalSize && (
                    <canvas
                      ref={canvasRef}
                      onPointerDown={handleDrawPointerDown}
                      onPointerMove={handleDrawPointerMove}
                      onPointerUp={handleDrawPointerUp}
                      onPointerCancel={handleDrawPointerCancel}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: drawEnabled ? 'auto' : 'none',
                        touchAction: 'none',
                      }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div
                ref={contentRef}
                onPointerDown={handleStagePointerDown}
                onPointerMove={handleStagePointerMove}
                onPointerUp={releasePointer}
                onPointerCancel={releasePointer}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: stageWidth,
                  height: stageHeight,
                  transform: `translate(calc(-50% + ${transform.x}px), calc(-50% + ${transform.y}px)) scale(${transform.scale})`,
                  transformOrigin: 'center center',
                  touchAction: 'none',
                  cursor: drawEnabled ? 'crosshair' : (transform.scale > 1 ? 'grab' : 'default'),
                }}
              >
                {isVideoAttachment ? (
                  <video
                    ref={videoRef}
                    key={previewSrc}
                    src={previewSrc}
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onError={handleImageError}
                    onClick={handleVideoClick}
                    style={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      borderRadius: 12,
                      background: '#000',
                      outline: 'none',
                      boxShadow: '0 24px 60px rgba(0,0,0,0.48)',
                      cursor: 'pointer',
                    }}
                  />
                ) : (
                  <img
                    ref={imageRef}
                    src={previewSrc}
                    alt={activeAttachment.name}
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    style={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      WebkitTouchCallout: 'none',
                    }}
                    draggable={false}
                  />
                )}
                {!isVideoAttachment && (
                  <canvas
                    ref={canvasRef}
                    onPointerDown={handleDrawPointerDown}
                    onPointerMove={handleDrawPointerMove}
                    onPointerUp={handleDrawPointerUp}
                    onPointerCancel={handleDrawPointerCancel}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: drawEnabled ? 'auto' : 'none',
                      touchAction: 'none',
                    }}
                  />
                )}
              </div>
            )
          )}

          {attachmentCount > 1 && (
            <>
              <button
                type="button"
                onClick={goPrev}
                disabled={!hasPrev}
                aria-label="Previous attachment"
                style={{
                  position: 'absolute',
                  left: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 44,
                  height: 44,
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(10,10,10,0.78)',
                  color: '#fff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: hasPrev ? 1 : 0.28,
                  pointerEvents: hasPrev ? 'auto' : 'none',
                  backdropFilter: 'blur(14px)',
                }}
              >
                <ChevronLeft size={20} strokeWidth={2.4} />
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!hasNext}
                aria-label="Next attachment"
                style={{
                  position: 'absolute',
                  right: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 44,
                  height: 44,
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(10,10,10,0.78)',
                  color: '#fff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: hasNext ? 1 : 0.28,
                  pointerEvents: hasNext ? 'auto' : 'none',
                  backdropFilter: 'blur(14px)',
                }}
              >
                <ChevronRight size={20} strokeWidth={2.4} />
              </button>
            </>
          )}
        </div>

        {previewSrc && !errorMessage && isVideoAttachment && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 24,
              transform: 'translateX(-50%)',
              width: 'min(calc(100vw - 32px), 920px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              pointerEvents: 'none',
            }}
          >
            {sendError && (
              <div
                style={{
                  maxWidth: 'min(100%, 520px)',
                  padding: '8px 12px',
                  borderRadius: 999,
                  background: 'rgba(88,20,24,0.88)',
                  border: '1px solid rgba(255,99,132,0.24)',
                  color: 'rgba(255,220,225,0.96)',
                  fontSize: 12,
                  lineHeight: 1.3,
                  textAlign: 'center',
                  pointerEvents: 'auto',
                }}
              >
                {sendError}
              </div>
            )}
            <VideoControlsPill videoRef={videoRef} />
          </div>
        )}

        {previewSrc && !errorMessage && !isVideoAttachment && !isDocAttachment && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              transform: 'translateX(-50%)',
              width: 'min(calc(100vw - 32px), 920px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              pointerEvents: 'none',
            }}
          >
            {sendError && (
              <div
                style={{
                  maxWidth: 'min(100%, 520px)',
                  padding: '8px 12px',
                  borderRadius: 999,
                  background: 'rgba(88,20,24,0.88)',
                  border: '1px solid rgba(255,99,132,0.24)',
                  color: 'rgba(255,220,225,0.96)',
                  fontSize: 12,
                  lineHeight: 1.3,
                  textAlign: 'center',
                  pointerEvents: 'auto',
                }}
              >
                {sendError}
              </div>
            )}
            {openPicker === 'color' && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 999,
                  background: 'rgba(10,10,10,0.82)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                  backdropFilter: 'blur(18px)',
                  pointerEvents: 'auto',
                }}
              >
                {ANNOTATION_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => {
                      setSelectedColor(color.value);
                      setOpenPicker(null);
                    }}
                    aria-label={color.label}
                    aria-pressed={selectedColor === color.value}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      border: selectedColor === color.value ? '2px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.16)',
                      background: color.value,
                      boxShadow: color.value === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,0.24)' : 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  />
                ))}
              </div>
            )}

            {openPicker === 'thickness' && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 999,
                  background: 'rgba(10,10,10,0.82)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                  backdropFilter: 'blur(18px)',
                  pointerEvents: 'auto',
                }}
              >
                {STROKE_WIDTHS.map((strokeWidth) => {
                  const isSelected = selectedWidth === strokeWidth.value;
                  const dotSize = 4 + strokeWidth.value;
                  return (
                    <button
                      key={strokeWidth.value}
                      type="button"
                      onClick={() => {
                        setSelectedWidth(strokeWidth.value);
                        setOpenPicker(null);
                      }}
                      aria-label={strokeWidth.label}
                      aria-pressed={isSelected}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 999,
                        border: isSelected ? '2px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.16)',
                        background: 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <span
                        style={{
                          width: dotSize,
                          height: dotSize,
                          borderRadius: 999,
                          background: 'rgba(255,255,255,0.85)',
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                padding: '6px 8px',
                borderRadius: 999,
                background: 'rgba(10,10,10,0.82)',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                backdropFilter: 'blur(18px)',
                pointerEvents: 'auto',
              }}
            >
              <IconButton
                onClick={() => {
                  setDrawEnabled((current) => !current);
                  setOpenPicker(null);
                }}
                active={drawEnabled}
                activeStrong
                ariaLabel="Toggle annotation"
              >
                <Highlighter size={16} strokeWidth={2.1} />
              </IconButton>

              <IconButton
                onClick={() => setOpenPicker((current) => (current === 'thickness' ? null : 'thickness'))}
                active={openPicker === 'thickness'}
                ariaLabel="Stroke thickness"
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    border: '1.5px solid rgba(255,255,255,0.6)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span
                    style={{
                      width: 4 + selectedWidth,
                      height: 4 + selectedWidth,
                      borderRadius: 999,
                      background: 'rgba(255,255,255,0.9)',
                    }}
                  />
                </span>
              </IconButton>

              <IconButton
                onClick={() => setOpenPicker((current) => (current === 'color' ? null : 'color'))}
                active={openPicker === 'color'}
                ariaLabel="Stroke color"
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: selectedColor,
                    boxShadow: selectedColor === '#ffffff'
                      ? 'inset 0 0 0 1px rgba(0,0,0,0.24)'
                      : 'inset 0 0 0 1px rgba(255,255,255,0.12)',
                  }}
                />
              </IconButton>

              <IconButton
                onClick={undoStroke}
                disabled={!hasAnnotations}
                ariaLabel="Undo"
              >
                <Undo2 size={16} strokeWidth={2.1} />
              </IconButton>

              <IconButton
                onClick={redoStroke}
                disabled={redoStack.length === 0}
                ariaLabel="Redo"
              >
                <Redo2 size={16} strokeWidth={2.1} />
              </IconButton>

              <IconButton
                onClick={clearAnnotations}
                disabled={!hasAnnotations}
                ariaLabel="Clear annotations"
              >
                <Trash size={16} strokeWidth={2.1} />
              </IconButton>

              <IconButton
                onClick={sendAnnotatedImage}
                disabled={!canSendAnnotated}
                ariaLabel="Send annotated image"
                accent
              >
                {isSending ? (
                  <Loader size={16} strokeWidth={2.1} className="animate-spin" />
                ) : (
                  <ArrowUp size={16} strokeWidth={2.3} />
                )}
              </IconButton>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
});

export default AttachmentViewerOverlay;
