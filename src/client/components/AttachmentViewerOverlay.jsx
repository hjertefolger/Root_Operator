import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronLeft, ChevronRight, Highlighter, Loader, Redo2, Trash, Undo2, X } from 'lucide-react';

const MAX_SCALE = 6;
const MAX_WEB_ZOOM = 8;
const MIN_SCALE = 1;
const WEB_ZOOM_EPSILON = 0.001;
const SWIPE_NAV_DISTANCE = 72;
const SWIPE_NAV_LONG_DISTANCE = 120;
const SWIPE_NAV_VELOCITY = 0.35;
const SWIPE_NAV_VERTICAL_DRIFT = 48;
const EMPTY_ANNOTATIONS = { strokes: [], redo: [] };
const ANNOTATION_COLORS = [
  { value: '#0a84ff', label: 'Blue' },
  { value: '#ff453a', label: 'Red' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#32d74b', label: 'Green' },
  { value: '#ffffff', label: 'White' },
  { value: '#111111', label: 'Black' },
];
const STROKE_WIDTHS = [
  { value: 2, label: 'Thin' },
  { value: 4, label: 'Medium' },
  { value: 8, label: 'Thick' },
  { value: 12, label: 'Bold' },
];
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

function drawStroke(ctx, stroke, displayScale) {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) {
    return;
  }

  const previewWidth = stroke.width * displayScale;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = previewWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    ctx.beginPath();
    ctx.arc(point.x * displayScale, point.y * displayScale, previewWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x * displayScale, stroke.points[0].y * displayScale);
  for (let index = 1; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    ctx.lineTo(point.x * displayScale, point.y * displayScale);
  }
  ctx.stroke();
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

const AttachmentViewerOverlay = memo(function AttachmentViewerOverlay({
  attachments,
  externalRef,
  initialIndex = 0,
  attachmentCache,
  attachmentFetchState,
  onRequestAttachment,
  onQueueAnnotatedAttachment,
  onSendAnnotatedAttachment,
  onClose,
}) {
  const viewportRef = useRef(null);
  const viewportRectRef = useRef(getViewportFallbackRect());
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const contentRef = useRef(null);
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const webViewRef = useRef({ zoom: 1, x: 0, y: 0 });
  const webViewFrameRef = useRef(0);
  const webPendingViewRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef({ mode: 'idle' });
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
  const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
  const isDesktopSurface = typeof window !== 'undefined' && Boolean(window.electronAPI);
  const useLayoutZoomViewer = !isDesktopSurface;
  const activeAttachment = attachmentCount > 0 ? attachments[activeIndex] : null;
  const attachmentId = activeAttachment?.id || '';
  const cachedAttachment = attachmentId ? attachmentCache?.[attachmentId] : null;
  const resolvedAttachment = cachedAttachment
    ? { ...activeAttachment, ...cachedAttachment }
    : activeAttachment;
  const previewSrc = getAttachmentPreviewSrc(resolvedAttachment);
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

  const handleImageError = useCallback(() => {
    setImageLoadError('Unable to render this image');
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
  }, [navigateBySwipe, useLayoutZoomViewer]);

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
          paddingBottom: 92,
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
              pointerEvents: 'auto',
              cursor: 'pointer',
            }}
          >
            <X size={16} strokeWidth={2} />
          </button>
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
          {(isLoading || (previewSrc && naturalSize.width === 0 && !errorMessage) || (!previewSrc && !errorMessage)) && (
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
              <span style={{ fontSize: 13 }}>Loading image...</span>
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

          {previewSrc && (
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
                  {hasNaturalSize && (
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

        {previewSrc && !errorMessage && (
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
