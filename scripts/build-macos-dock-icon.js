const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_SVG = path.join(ROOT, 'build', 'icon-macos-dock.svg');
const RABBIT_SVG = path.join(ROOT, 'src', 'client', 'assets', 'rabbit.svg');
const OUTPUT_PNG = path.join(ROOT, 'public', 'icon-macos-dock.png');

const CANVAS_SIZE = 1024;
const DOCK_BASE_X = 88;
const DOCK_BASE_Y = 76;
const DOCK_BASE_SIZE = 848;
const RABBIT_SOURCE_WIDTH = 696;
const RABBIT_SOURCE_HEIGHT = 456;
const RABBIT_SCALE = 0.76;
const RABBIT_OFFSET_X = -6;
const RABBIT_OFFSET_Y = -20;
const RABBIT_WIDTH = Math.round(RABBIT_SOURCE_WIDTH * RABBIT_SCALE);
const RABBIT_HEIGHT = Math.round(RABBIT_SOURCE_HEIGHT * RABBIT_SCALE);
const RABBIT_X = Math.round(DOCK_BASE_X + (DOCK_BASE_SIZE - RABBIT_WIDTH) / 2 + RABBIT_OFFSET_X);
const RABBIT_Y = Math.round(DOCK_BASE_Y + (DOCK_BASE_SIZE - RABBIT_HEIGHT) / 2 + RABBIT_OFFSET_Y);
const RABBIT_GRADIENT_TOP = { r: 255, g: 255, b: 255 };
const RABBIT_GRADIENT_MID = { r: 237, g: 239, b: 244 };
const RABBIT_GRADIENT_BOTTOM = { r: 199, g: 204, b: 214 };

function renderSvg(svgPath, width, height, outputPath) {
  execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), svgPath, '-o', outputPath], {
    stdio: 'inherit',
  });
}

function blendPixel(target, offset, rgba, alphaMultiplier = 1) {
  const srcAlpha = (rgba.a / 255) * alphaMultiplier;
  if (srcAlpha <= 0) return;

  const dstAlpha = target[offset + 3] / 255;
  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);
  if (outAlpha <= 0) return;

  const srcWeight = srcAlpha / outAlpha;
  const dstWeight = (dstAlpha * (1 - srcAlpha)) / outAlpha;

  target[offset] = Math.round(rgba.r * srcWeight + target[offset] * dstWeight);
  target[offset + 1] = Math.round(rgba.g * srcWeight + target[offset + 1] * dstWeight);
  target[offset + 2] = Math.round(rgba.b * srcWeight + target[offset + 2] * dstWeight);
  target[offset + 3] = Math.round(outAlpha * 255);
}

function composite(base, overlay, destX, destY) {
  for (let y = 0; y < overlay.height; y += 1) {
    const targetY = destY + y;
    if (targetY < 0 || targetY >= base.height) continue;

    for (let x = 0; x < overlay.width; x += 1) {
      const targetX = destX + x;
      if (targetX < 0 || targetX >= base.width) continue;

      const sourceOffset = (overlay.width * y + x) << 2;
      const alpha = overlay.data[sourceOffset + 3];
      if (!alpha) continue;

      const targetOffset = (base.width * targetY + targetX) << 2;
      blendPixel(base.data, targetOffset, {
        r: overlay.data[sourceOffset],
        g: overlay.data[sourceOffset + 1],
        b: overlay.data[sourceOffset + 2],
        a: alpha,
      });
    }
  }
}

function interpolateChannel(start, end, amount) {
  return Math.round(start + (end - start) * amount);
}

function applyRabbitGradient(image) {
  for (let y = 0; y < image.height; y += 1) {
    const t = y / Math.max(1, image.height - 1);
    const blend = t < 0.52 ? t / 0.52 : (t - 0.52) / 0.48;
    const from = t < 0.52 ? RABBIT_GRADIENT_TOP : RABBIT_GRADIENT_MID;
    const to = t < 0.52 ? RABBIT_GRADIENT_MID : RABBIT_GRADIENT_BOTTOM;

    for (let x = 0; x < image.width; x += 1) {
      const offset = (image.width * y + x) << 2;
      if (!image.data[offset + 3]) continue;

      image.data[offset] = interpolateChannel(from.r, to.r, blend);
      image.data[offset + 1] = interpolateChannel(from.g, to.g, blend);
      image.data[offset + 2] = interpolateChannel(from.b, to.b, blend);
    }
  }
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-operator-mac-icon-'));
  const backgroundPng = path.join(tempDir, 'background.png');
  const rabbitPng = path.join(tempDir, 'rabbit.png');

  try {
    renderSvg(BACKGROUND_SVG, CANVAS_SIZE, CANVAS_SIZE, backgroundPng);
    renderSvg(RABBIT_SVG, RABBIT_WIDTH, RABBIT_HEIGHT, rabbitPng);

    const background = PNG.sync.read(fs.readFileSync(backgroundPng));
    const rabbit = PNG.sync.read(fs.readFileSync(rabbitPng));

    applyRabbitGradient(rabbit);
    composite(background, rabbit, RABBIT_X, RABBIT_Y);

    fs.writeFileSync(OUTPUT_PNG, PNG.sync.write(background));
    console.log(`Wrote ${OUTPUT_PNG}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
