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

function seededRandomFactory(seed) {
    let state = (Number.isFinite(seed) ? seed : 1) >>> 0;
    if (state === 0) state = 0x9e3779b9;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildGridDots(size, seed) {
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const step = Math.max(6, HALO.gridStepPx || 10);
    const radius = Math.max(0.55, HALO.gridDotRadiusPx || 0.95);
    const maxOpacity = Math.max(0.04, HALO.gridMaxOpacity || 0.24);
    const random = seededRandomFactory(seed);
    const dots = [];
    const startX = Math.max(0, PAD - step);
    const startY = Math.max(0, PAD - step);
    const endX = Math.min(width, width - PAD + step);
    const endY = Math.min(height, height - PAD + step);
    const cornerX = width - PAD * 0.65;
    const cornerY = PAD * 0.75;
    const centerX = width * 0.52;
    const centerY = height * 0.52;
    const reach = Math.max(56, Math.hypot(width, height) * 0.72);
    const centerClear = Math.max(18, Math.min(width, height) * 0.3);
    let id = 0;

    for (let y = startY; y <= endY; y += step) {
        for (let x = startX; x <= endX; x += step) {
            const jitterX = (random() - 0.5) * 1.2;
            const jitterY = (random() - 0.5) * 1.2;
            const px = x + jitterX;
            const py = y + jitterY;
            const distCorner = Math.hypot(px - cornerX, py - cornerY);
            const distCenter = Math.hypot(px - centerX, py - centerY);
            const cornerFalloff = clamp01(1 - distCorner / reach);
            const centerFade = clamp01((distCenter - centerClear) / Math.max(1, reach * 0.58));
            const diagonalX = (px - centerX) / Math.max(1, cornerX - centerX);
            const diagonalY = (centerY - py) / Math.max(1, centerY - cornerY);
            const diagonalBias = clamp01((diagonalX + diagonalY + 0.18) / 2.05);
            const opacity = maxOpacity
                * Math.pow(cornerFalloff, 1.35)
                * Math.pow(centerFade, 0.62)
                * (0.34 + diagonalBias * 0.66);
            if (opacity < 0.016) continue;

            const duration = 2800 + random() * 1800;
            dots.push({
                id: id++,
                x: px,
                y: py,
                r: radius + (random() - 0.5) * 0.18,
                opacity,
                lowOpacity: opacity * 0.5,
                delay: -random() * duration,
                duration,
                shiftX: -0.65 - random() * 0.8,
                shiftY: 0.55 + random() * 0.85,
            });
        }
    }
    return dots;
}

export default function AgentHaloView() {
    const [visible, setVisible] = useState(false);
    const [payload, setPayload] = useState({ width: 0, height: 0, seed: 1, accent: ACCENT });

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
    const gridDots = useMemo(() => buildGridDots(size, payload.seed), [size.width, size.height, payload.seed]);
    const fadeInMs = HALO.fadeInMs || 250;
    const fadeOutMs = HALO.fadeOutMs || 400;
    const borderScanMs = HALO.borderScanDurationMs || 3600;
    const cornerTraceLength = Math.max(18, Math.min(38, Math.min(innerWidth, innerHeight) * 0.42));

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
                @keyframes agentHaloGridTravel {
                    0%, 100% { opacity: var(--dot-opacity-low); transform: translate(0px, 0px); }
                    46% { opacity: var(--dot-opacity); transform: translate(var(--dot-shift-x), var(--dot-shift-y)); }
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
                </defs>
                <rect
                    x={PAD - 8}
                    y={PAD - 8}
                    width={innerWidth + 16}
                    height={innerHeight + 16}
                    rx="12"
                    fill="url(#agent-halo-wash)"
                    opacity="0.72"
                    filter="url(#agent-halo-soften)"
                />
                {gridDots.map((dot) => (
                    <circle
                        key={dot.id}
                        cx={dot.x}
                        cy={dot.y}
                        r={dot.r}
                        fill={accent}
                        style={{
                            '--dot-opacity': dot.opacity,
                            '--dot-opacity-low': dot.lowOpacity,
                            '--dot-shift-x': `${dot.shiftX}px`,
                            '--dot-shift-y': `${dot.shiftY}px`,
                            transformOrigin: `${dot.x}px ${dot.y}px`,
                            animation: `agentHaloGridTravel ${dot.duration}ms ease-in-out ${dot.delay}ms infinite`,
                        }}
                    />
                ))}
                <path
                    d={[
                        `M ${PAD + innerWidth - cornerTraceLength} ${PAD}`,
                        `H ${PAD + innerWidth}`,
                        `V ${PAD + cornerTraceLength}`,
                    ].join(' ')}
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
                    rx="8"
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
