/**
 * AGENT HALO VIEW
 *
 * Dotted presence field drawn around an AX element the agent is acting on.
 * Sized by the main process to (frame.w + PAD*2, frame.h + PAD*2).
 * The field is densest at the top-right edge, then fades toward the
 * target center so it reads like an infinite-canvas grid instead of a
 * generic glow ring.
 *
 * State arrives via IPC:
 *   AGENT_HALO_SHOW {width, height}  — fade in
 *   AGENT_HALO_HIDE                  — fade out
 */
import { useEffect, useMemo, useState } from 'react';
import presenceMotionConfig from '../../shared/presence-motion-config.json';

const HALO = presenceMotionConfig.halo || {};
const ACCENT = HALO.accent || '#4B6BFF';
const PAD = HALO.padPx || 18;

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function clampRadius(value, width, height) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.min(value, Math.max(0, Math.min(width, height) / 2)));
}

function buildGridDots(size) {
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const step = Math.max(7, HALO.gridStepPx || 10);
    const radius = Math.max(0.65, Math.min(1.25, HALO.gridDotRadiusPx || 0.95));
    const maxOpacity = Math.max(0.08, HALO.gridMaxOpacity || 0.26);
    const dots = [];
    const startX = Math.max(0, PAD - 8);
    const startY = Math.max(0, PAD - 8);
    const endX = Math.min(width, width - PAD + 8);
    const endY = Math.min(height, height - PAD + 8);
    const gradientStart = { x: width - PAD * 0.55, y: PAD * 0.45 };
    const gradientEnd = { x: width * 0.42, y: height * 0.56 };
    const vx = gradientEnd.x - gradientStart.x;
    const vy = gradientEnd.y - gradientStart.y;
    const lenSq = Math.max(1, vx * vx + vy * vy);
    const len = Math.sqrt(lenSq);
    const bandWidth = Math.max(44, Math.hypot(width, height) * 0.56);
    let id = 0;

    for (let y = startY; y <= endY; y += step) {
        for (let x = startX; x <= endX; x += step) {
            const px = x;
            const py = y;
            const dx = px - gradientStart.x;
            const dy = py - gradientStart.y;
            const t = clamp01((dx * vx + dy * vy) / lenSq);
            const axisDistance = Math.abs(dx * vy - dy * vx) / len;
            const alongFade = Math.pow(1 - t, 1.55);
            const bandFade = Math.pow(clamp01(1 - axisDistance / bandWidth), 0.9);
            const topRightBias = clamp01((px / width) * 0.56 + ((height - py) / height) * 0.44);
            const opacity = maxOpacity
                * alongFade
                * (0.28 + bandFade * 0.72)
                * (0.38 + topRightBias * 0.62);
            if (opacity < 0.018) continue;

            dots.push({
                id: id++,
                x: px,
                y: py,
                r: radius,
                opacity,
            });
        }
    }
    return dots;
}

export default function AgentHaloView() {
    const [visible, setVisible] = useState(false);
    const [payload, setPayload] = useState({ width: 0, height: 0, seed: 1, accent: ACCENT, borderRadius: 0 });

    useEffect(() => {
        if (!window.electronAPI || typeof window.electronAPI.on !== 'function') return;
        const unsubShow = window.electronAPI.on('AGENT_HALO_SHOW', (payload) => {
            if (payload && Number.isFinite(payload.width) && Number.isFinite(payload.height)) {
                setPayload({
                    width: payload.width,
                    height: payload.height,
                    seed: Number.isFinite(payload.seed) ? payload.seed : Date.now(),
                    accent: payload.accent || ACCENT,
                    mode: payload.mode || 'action',
                    borderRadius: Number.isFinite(payload.borderRadius) ? payload.borderRadius : 0,
                });
            }
            setVisible(true);
        });
        const unsubHide = window.electronAPI.on('AGENT_HALO_HIDE', () => {
            setVisible(false);
        });
        return () => {
            if (typeof unsubShow === 'function') unsubShow();
            if (typeof unsubHide === 'function') unsubHide();
        };
    }, []);

    const size = { width: payload.width, height: payload.height };
    const innerWidth = Math.max(0, payload.width - PAD * 2);
    const innerHeight = Math.max(0, payload.height - PAD * 2);
    const accent = payload.accent || ACCENT;
    const gridDots = useMemo(() => buildGridDots(size), [size.width, size.height]);
    const fadeInMs = HALO.fadeInMs || 250;
    const fadeOutMs = HALO.fadeOutMs || 400;
    const borderScanMs = HALO.borderScanDurationMs || 3600;
    const targetRadius = clampRadius(payload.borderRadius, innerWidth, innerHeight);
    const fieldInset = 8;
    const fieldX = PAD - fieldInset;
    const fieldY = PAD - fieldInset;
    const fieldWidth = innerWidth + fieldInset * 2;
    const fieldHeight = innerHeight + fieldInset * 2;
    const fieldRadius = clampRadius(targetRadius > 0 ? targetRadius + fieldInset : 0, fieldWidth, fieldHeight);
    const maxCornerTrace = Math.max(0, Math.min(innerWidth, innerHeight));
    const cornerTraceLength = Math.min(maxCornerTrace, Math.max(
        targetRadius + 14,
        Math.min(42, maxCornerTrace * 0.42),
    ));
    const edgeTracePath = targetRadius > 0
        ? [
            `M ${PAD + innerWidth - cornerTraceLength} ${PAD}`,
            `H ${PAD + innerWidth - targetRadius}`,
            `Q ${PAD + innerWidth} ${PAD} ${PAD + innerWidth} ${PAD + targetRadius}`,
            `V ${PAD + cornerTraceLength}`,
        ].join(' ')
        : [
            `M ${PAD + innerWidth - cornerTraceLength} ${PAD}`,
            `H ${PAD + innerWidth}`,
            `V ${PAD + cornerTraceLength}`,
        ].join(' ');

    return (
        <div
            style={{
                width: '100vw',
                height: '100vh',
                margin: 0,
                padding: 0,
                background: 'transparent',
                pointerEvents: 'none',
                position: 'relative',
                opacity: visible ? 1 : 0,
                transition: `opacity ${visible ? fadeInMs : fadeOutMs}ms ease-out`,
            }}
        >
            <style>{`
                @keyframes agentHaloScan {
                    from { stroke-dashoffset: 0; }
                    to { stroke-dashoffset: -180; }
                }
                @keyframes agentHaloEdgeTrace {
                    0%, 100% { opacity: 0.18; }
                    44% { opacity: 0.42; }
                }
            `}</style>
            <svg
                width="100%"
                height="100%"
                viewBox={`0 0 ${Math.max(1, payload.width)} ${Math.max(1, payload.height)}`}
                preserveAspectRatio="none"
                style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'visible',
                    pointerEvents: 'none',
                }}
            >
                <defs>
                    <filter id="agent-halo-soften" x="-15%" y="-15%" width="130%" height="130%">
                        <feGaussianBlur stdDeviation="2.5" />
                    </filter>
                    <linearGradient id="agent-halo-wash" x1="100%" y1="0%" x2="42%" y2="56%">
                        <stop offset="0%" stopColor={accent} stopOpacity="0.16" />
                        <stop offset="48%" stopColor={accent} stopOpacity="0.045" />
                        <stop offset="100%" stopColor={accent} stopOpacity="0" />
                    </linearGradient>
                    <clipPath id="agent-halo-field-clip">
                        <rect
                            x={fieldX}
                            y={fieldY}
                            width={fieldWidth}
                            height={fieldHeight}
                            rx={fieldRadius}
                            ry={fieldRadius}
                        />
                    </clipPath>
                </defs>
                <rect
                    x={fieldX}
                    y={fieldY}
                    width={fieldWidth}
                    height={fieldHeight}
                    rx={fieldRadius}
                    ry={fieldRadius}
                    fill="url(#agent-halo-wash)"
                    opacity="0.72"
                    filter="url(#agent-halo-soften)"
                />
                <g clipPath="url(#agent-halo-field-clip)" style={{ mixBlendMode: 'screen' }}>
                    {gridDots.map((dot) => (
                        <circle
                            key={dot.id}
                            cx={dot.x}
                            cy={dot.y}
                            r={dot.r}
                            fill={accent}
                            opacity={dot.opacity}
                        />
                    ))}
                </g>
                <path
                    d={edgeTracePath}
                    fill="none"
                    stroke={accent}
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    opacity={HALO.borderOpacityMax || 0.34}
                    style={{ animation: `agentHaloEdgeTrace ${borderScanMs}ms ease-in-out infinite` }}
                />
                <rect
                    x={PAD}
                    y={PAD}
                    width={innerWidth}
                    height={innerHeight}
                    rx={targetRadius}
                    ry={targetRadius}
                    fill="none"
                    stroke={accent}
                    strokeWidth="1"
                    strokeDasharray="1 10"
                    strokeLinecap="round"
                    opacity={HALO.borderOpacityMin || 0.15}
                    style={{
                        animation: `agentHaloScan ${borderScanMs}ms linear infinite`,
                    }}
                />
            </svg>
        </div>
    );
}
