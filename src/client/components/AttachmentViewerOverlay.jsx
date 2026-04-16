import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Loader, PenLine, Redo2, SendHorizontal, Trash2, Undo2, X } from 'lucide-react';

const MAX_SCALE = 6;
const MIN_SCALE = 1;
const EMPTY_ANNOTATIONS = { strokes: [], redo: [] };
const ANNOTATION_COLORS = [
  { value: '#ff453a', label: 'Red' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#32d74b', label: 'Green' },
  { value: '#0a84ff', label: 'Blue' },
  { value: '#ffffff', label: 'White' },
  { value: '#111111', label: 'Black' },
];
const STROKE_WIDTHS = [
  { value: 2, label: 'Thin' },
  { value: 4, label: 'Medium' },
  { value: 8, label: 'Thick' },
  { value: 12, label: 'Bold' },
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
  viewportRect,
  transform,
  stageWidth,
  stageHeight,
  naturalWidth,
  naturalHeight,
}) {
  if (!viewportRect.width || !viewportRect.height || !stageWidth || !stageHeight || !naturalWidth || !naturalHeight) {
    return null;
  }

  const viewportCenterX = viewportRect.left + (viewportRect.width / 2);
  const viewportCenterY = viewportRect.top + (viewportRect.height / 2);
  const stageLeft = viewportCenterX + transform.x - ((stageWidth * transform.scale) / 2);
  const stageTop = viewportCenterY + transform.y - ((stageHeight * transform.scale) / 2);
  const baseX = (clientX - stageLeft) / transform.scale;
  const baseY = (clientY - stageTop) / transform.scale;

  if (baseX < 0 || baseY < 0 || baseX > stageWidth || baseY > stageHeight) {
    return null;
  }

  return {
    x: baseX * (naturalWidth / stageWidth),
    y: baseY * (naturalHeight / stageHeight),
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
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const gestureRef = useRef({ mode: 'idle' });
  const drawingPointerIdRef = useRef(null);
  const draftStrokeRef = useRef(null);
  const renderFrameRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [viewportRect, setViewportRect] = useState({ width: 0, height: 0, left: 0, top: 0 });
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [imageLoadError, setImageLoadError] = useState('');
  const [annotationState, setAnnotationState] = useState({});
  const [drawEnabled, setDrawEnabled] = useState(false);
  const [selectedColor, setSelectedColor] = useState(ANNOTATION_COLORS[0].value);
  const [selectedWidth, setSelectedWidth] = useState(STROKE_WIDTHS[1].value);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
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
  const canSendAnnotated = Boolean(
    hasAnnotations
    && !isSending
    && typeof annotatedAttachmentHandler === 'function'
    && imageRef.current
    && naturalSize.width > 0
    && naturalSize.height > 0
    && !errorMessage
  );

  const fitScale = (naturalSize.width > 0 && naturalSize.height > 0 && viewportRect.width > 0 && viewportRect.height > 0)
    ? Math.min(viewportRect.width / naturalSize.width, viewportRect.height / naturalSize.height)
    : 0;
  const stageWidth = fitScale > 0 ? naturalSize.width * fitScale : 0;
  const stageHeight = fitScale > 0 ? naturalSize.height * fitScale : 0;
  const hasStage = stageWidth > 0 && stageHeight > 0;
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < (attachmentCount - 1);

  const measureViewport = useCallback(() => {
    const nextRect = viewportRef.current?.getBoundingClientRect();
    if (!nextRect) {
      return;
    }
    setViewportRect({
      width: nextRect.width,
      height: nextRect.height,
      left: nextRect.left,
      top: nextRect.top,
    });
  }, []);

  const resetTransform = useCallback(() => {
    const next = { scale: 1, x: 0, y: 0 };
    transformRef.current = next;
    setTransform(next);
  }, []);

  const clampTransform = useCallback((nextTransform, nextScale = nextTransform.scale) => {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (!hasStage || viewportRect.width <= 0 || viewportRect.height <= 0) {
      return { scale, x: 0, y: 0 };
    }

    const overflowX = Math.max(0, ((stageWidth * scale) - viewportRect.width) / 2);
    const overflowY = Math.max(0, ((stageHeight * scale) - viewportRect.height) / 2);

    return {
      scale,
      x: clamp(nextTransform.x, -overflowX, overflowX),
      y: clamp(nextTransform.y, -overflowY, overflowY),
    };
  }, [hasStage, stageHeight, stageWidth, viewportRect.height, viewportRect.width]);

  const commitTransform = useCallback((nextTransform) => {
    const clamped = clampTransform(nextTransform, nextTransform.scale);
    transformRef.current = clamped;
    setTransform(clamped);
    return clamped;
  }, [clampTransform]);

  const zoomAtPoint = useCallback((nextScale, anchorClientPoint) => {
    if (!hasStage) {
      return;
    }

    const current = transformRef.current;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(scale - current.scale) < 0.001) {
      return;
    }

    const anchor = {
      x: anchorClientPoint.x - viewportRect.left,
      y: anchorClientPoint.y - viewportRect.top,
    };
    const viewportCenter = {
      x: viewportRect.width / 2,
      y: viewportRect.height / 2,
    };
    const anchorDx = anchor.x - viewportCenter.x;
    const anchorDy = anchor.y - viewportCenter.y;
    const ratio = scale / current.scale;

    commitTransform({
      scale,
      x: anchorDx - ((anchorDx - current.x) * ratio),
      y: anchorDy - ((anchorDy - current.y) * ratio),
    });
  }, [commitTransform, hasStage, viewportRect.height, viewportRect.left, viewportRect.top, viewportRect.width]);

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

  useEffect(() => {
    setNaturalSize({ width: 0, height: 0 });
    setImageLoadError('');
    setSendError('');
    setIsSending(false);
    clearPointers();
    resetTransform();
  }, [activeAttachment?.id, clearPointers, resetTransform]);

  useEffect(() => {
    if (viewportRect.width <= 0 || viewportRect.height <= 0) {
      return;
    }
    clearPointers();
    resetTransform();
  }, [clearPointers, resetTransform, viewportRect.height, viewportRect.width]);

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

    const displayWidth = Math.max(1, Math.round(stageWidth));
    const displayHeight = Math.max(1, Math.round(stageHeight));
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(displayWidth * devicePixelRatio) || canvas.height !== Math.round(displayHeight * devicePixelRatio)) {
      canvas.width = Math.round(displayWidth * devicePixelRatio);
      canvas.height = Math.round(displayHeight * devicePixelRatio);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    const previewScale = displayWidth / naturalSize.width;
    for (const stroke of strokes) {
      drawStroke(ctx, stroke, previewScale);
    }

    if (draftStrokeRef.current) {
      drawStroke(ctx, draftStrokeRef.current, previewScale);
    }
  }, [hasStage, naturalSize.height, naturalSize.width, stageHeight, stageWidth, strokes]);

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
    if (!drawEnabled || !previewSrc || !hasStage) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const point = getImagePointFromClient({
      clientX: event.clientX,
      clientY: event.clientY,
      viewportRect,
      transform: transformRef.current,
      stageWidth,
      stageHeight,
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
  }, [drawEnabled, hasStage, naturalSize.height, naturalSize.width, previewSrc, scheduleCanvasRender, selectedColor, selectedWidth, stageHeight, stageWidth, viewportRect]);

  const handleDrawPointerMove = useCallback((event) => {
    if (drawingPointerIdRef.current !== event.pointerId || !draftStrokeRef.current) {
      return;
    }

    const point = getImagePointFromClient({
      clientX: event.clientX,
      clientY: event.clientY,
      viewportRect,
      transform: transformRef.current,
      stageWidth,
      stageHeight,
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
  }, [naturalSize.height, naturalSize.width, scheduleCanvasRender, stageHeight, stageWidth, viewportRect]);

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
    if (!hasStage) {
      return;
    }

    event.preventDefault();
    const scaleDelta = Math.exp(-event.deltaY * 0.0025);
    zoomAtPoint(transformRef.current.scale * scaleDelta, {
      x: event.clientX,
      y: event.clientY,
    });
  }, [hasStage, zoomAtPoint]);

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
  }, [drawEnabled, previewSrc]);

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

  const releasePointer = useCallback((event) => {
    pointersRef.current.delete(event.pointerId);

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
  }, []);

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
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minWidth: 0,
              maxWidth: 'min(520px, 100%)',
              padding: '12px 14px',
              borderRadius: 999,
              background: 'rgba(16,16,16,0.82)',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
              backdropFilter: 'blur(14px)',
              pointerEvents: 'auto',
            }}
          >
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.2,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.45)',
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
              }}
            >
              Attachment {activeIndex + 1} / {attachmentCount}
            </span>
            <span
              style={{
                fontSize: 14,
                lineHeight: 1.35,
                color: 'rgba(255,255,255,0.92)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {activeAttachment.name}
            </span>
            <span
              style={{
                fontSize: 12,
                lineHeight: 1.2,
                color: 'rgba(255,255,255,0.48)',
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
              }}
            >
              {Math.round(transform.scale * 100)}% zoom
            </span>
          </div>

          <button
            type="button"
            onClick={() => onClose?.()}
            aria-label="Close attachment viewer"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(16,16,16,0.82)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
              backdropFilter: 'blur(14px)',
              pointerEvents: 'auto',
            }}
          >
            <X size={18} strokeWidth={2.2} />
          </button>
        </div>

        <div
          ref={viewportRef}
          onWheel={handleWheel}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose?.();
            }
          }}
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            borderRadius: 18,
            border: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.03)',
            boxShadow: '0 28px 80px rgba(0,0,0,0.38)',
            overflow: 'hidden',
            touchAction: 'pinch-zoom',
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
            <div
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
                onLoad={(event) => {
                  setImageLoadError('');
                  setNaturalSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                  measureViewport();
                }}
                onError={() => {
                  setImageLoadError('Unable to render this image');
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  borderRadius: 16,
                  boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
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
                  borderRadius: 16,
                  pointerEvents: drawEnabled ? 'auto' : 'none',
                  touchAction: 'none',
                }}
              />
            </div>
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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                flexWrap: 'wrap',
                padding: '10px 12px',
                borderRadius: 999,
                background: 'rgba(10,10,10,0.82)',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                backdropFilter: 'blur(18px)',
                pointerEvents: 'auto',
              }}
            >
              <button
                type="button"
                onClick={() => setDrawEnabled((current) => !current)}
                aria-pressed={drawEnabled}
                style={{
                  height: 36,
                  padding: '0 12px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: drawEnabled ? 'rgba(75,90,255,0.18)' : 'rgba(255,255,255,0.04)',
                  color: drawEnabled ? '#c8ceff' : 'rgba(255,255,255,0.78)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >
                <PenLine size={15} strokeWidth={2.1} />
                Draw
              </button>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {ANNOTATION_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setSelectedColor(color.value)}
                    aria-label={color.label}
                    aria-pressed={selectedColor === color.value}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      border: selectedColor === color.value ? '2px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.16)',
                      background: color.value,
                      boxShadow: color.value === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,0.24)' : 'none',
                    }}
                  />
                ))}
              </div>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {STROKE_WIDTHS.map((strokeWidth) => (
                  <button
                    key={strokeWidth.value}
                    type="button"
                    onClick={() => setSelectedWidth(strokeWidth.value)}
                    aria-label={strokeWidth.label}
                    aria-pressed={selectedWidth === strokeWidth.value}
                    style={{
                      width: 38,
                      height: 32,
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: selectedWidth === strokeWidth.value ? 'rgba(75,90,255,0.18)' : 'rgba(255,255,255,0.04)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: strokeWidth.value,
                        borderRadius: 999,
                        background: selectedColor,
                        boxShadow: selectedColor === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,0.2)' : 'none',
                      }}
                    />
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={undoStroke}
                disabled={!hasAnnotations}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.8)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: hasAnnotations ? 1 : 0.36,
                }}
              >
                <Undo2 size={15} strokeWidth={2.1} />
              </button>

              <button
                type="button"
                onClick={redoStroke}
                disabled={redoStack.length === 0}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.8)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: redoStack.length > 0 ? 1 : 0.36,
                }}
              >
                <Redo2 size={15} strokeWidth={2.1} />
              </button>

              <button
                type="button"
                onClick={clearAnnotations}
                disabled={!hasAnnotations}
                style={{
                  height: 36,
                  padding: '0 12px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.78)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: hasAnnotations ? 1 : 0.36,
                }}
              >
                <Trash2 size={15} strokeWidth={2.1} />
                Clear
              </button>

              <button
                type="button"
                onClick={sendAnnotatedImage}
                disabled={!canSendAnnotated}
                style={{
                  height: 36,
                  padding: '0 14px',
                  borderRadius: 999,
                  border: '1px solid rgba(75,90,255,0.24)',
                  background: canSendAnnotated ? 'rgba(75,90,255,0.18)' : 'rgba(255,255,255,0.04)',
                  color: canSendAnnotated ? '#d7dcff' : 'rgba(255,255,255,0.42)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {isSending ? (
                  <Loader size={15} strokeWidth={2.1} className="animate-spin" />
                ) : (
                  <SendHorizontal size={15} strokeWidth={2.1} />
                )}
                Send Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
});

export default AttachmentViewerOverlay;
