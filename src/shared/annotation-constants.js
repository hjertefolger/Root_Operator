/**
 * Shared annotation primitives.
 * Used by:
 *   - src/client/components/AttachmentViewerOverlay.jsx (web/PWA chat — annotating images received from chat)
 *   - src/renderer/components/CursorAnnotationView.jsx  (Electron cursor presence — annotating screen captures)
 *
 * Keep byte-for-byte identical so both surfaces produce visually
 * identical strokes from the same color/width inputs.
 */

export const ANNOTATION_COLORS = [
  { value: '#0a84ff', label: 'Blue' },
  { value: '#ff453a', label: 'Red' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#32d74b', label: 'Green' },
  { value: '#ffffff', label: 'White' },
  { value: '#111111', label: 'Black' },
];

export const STROKE_WIDTHS = [
  { value: 2, label: 'Thin' },
  { value: 4, label: 'Medium' },
  { value: 8, label: 'Thick' },
  { value: 12, label: 'Bold' },
];

/**
 * Draw a single stroke onto a canvas 2D context. Strokes use round
 * caps/joins for smooth lines and degrade to a filled circle when the
 * pointer hasn't moved (single-point taps).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ points: Array<{x:number,y:number}>, color: string, width: number }} stroke
 *   Points are in the source image's coordinate space; the caller
 *   provides displayScale so we can render onto preview canvases AND
 *   the final native-resolution composite from the same point data.
 * @param {number} displayScale  — multiplier from source to render space
 */
export function drawStroke(ctx, stroke, displayScale) {
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
