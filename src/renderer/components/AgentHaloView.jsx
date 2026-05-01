/**
 * AGENT HALO VIEW
 *
 * Soft accent glow drawn around an AX element the agent is acting on.
 * Sized by the main process to (frame.w + PAD*2, frame.h + PAD*2).
 * Inset rounded rectangle with a layered glow gradient + 1px stroke.
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

function buildSpots(size, seed) {
    const count = HALO.waveSpotCount || 42;
    const random = seededRandomFactory(seed);
    const innerWidth = Math.max(1, size.width - PAD * 2);
    const innerHeight = Math.max(1, size.height - PAD * 2);
    const spots = [];
    for (let i = 0; i < count; i += 1) {
        const angle = random() * Math.PI * 2;
        const radial = Math.pow(random(), 0.72);
        const x = PAD + innerWidth * 0.5 + Math.cos(angle) * innerWidth * 0.48 * radial;
        const y = PAD + innerHeight * 0.5 + Math.sin(angle) * innerHeight * 0.48 * radial;
        spots.push({
            id: i,
            x,
            y,
            r: 1.6 + random() * 3.2,
            duration: (HALO.waveMinDurationMs || 1500) + random() * ((HALO.waveMaxDurationMs || 3000) - (HALO.waveMinDurationMs || 1500)),
            delay: -random() * (HALO.waveMaxDurationMs || 3000),
            opacity: 0.05 + random() * ((HALO.waveMaxOpacity || 0.18) - 0.05),
        });
    }
    return spots;
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
    const spots = useMemo(() => buildSpots(size, payload.seed), [size.width, size.height, payload.seed]);
    const fadeInMs = HALO.fadeInMs || 250;
    const fadeOutMs = HALO.fadeOutMs || 400;
    const borderScanMs = HALO.borderScanDurationMs || 3600;

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
                @keyframes agentHaloWave {
                    0%, 100% { opacity: 0.025; transform: scale(0.82); }
                    45% { opacity: var(--spot-opacity); transform: scale(1); }
                    70% { opacity: var(--spot-fade-opacity); transform: scale(1.08); }
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
                    <filter id="agent-halo-soften" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="4" />
                    </filter>
                </defs>
                <rect
                    x={PAD - 7}
                    y={PAD - 7}
                    width={innerWidth + 14}
                    height={innerHeight + 14}
                    rx="10"
                    fill="none"
                    stroke={accent}
                    strokeWidth="8"
                    opacity="0.08"
                    filter="url(#agent-halo-soften)"
                />
                {spots.map((spot) => (
                    <circle
                        key={spot.id}
                        cx={spot.x}
                        cy={spot.y}
                        r={spot.r}
                        fill={accent}
                        style={{
                            '--spot-opacity': spot.opacity,
                            '--spot-fade-opacity': spot.opacity * 0.58,
                            opacity: 0.04,
                            transformOrigin: `${spot.x}px ${spot.y}px`,
                            animation: `agentHaloWave ${spot.duration}ms ease-in-out ${spot.delay}ms infinite`,
                        }}
                    />
                ))}
                <rect
                    x={PAD}
                    y={PAD}
                    width={innerWidth}
                    height={innerHeight}
                    rx="8"
                    fill="none"
                    stroke={accent}
                    strokeWidth="1.2"
                    strokeDasharray="2 9"
                    strokeLinecap="round"
                    opacity={HALO.borderOpacityMax || 0.34}
                    style={{
                        animation: `agentHaloScan ${borderScanMs}ms linear infinite`,
                    }}
                />
                <rect
                    x={PAD + 0.5}
                    y={PAD + 0.5}
                    width={Math.max(0, innerWidth - 1)}
                    height={Math.max(0, innerHeight - 1)}
                    rx="8"
                    fill="none"
                    stroke={accent}
                    strokeWidth="1"
                    opacity={HALO.borderOpacityMin || 0.15}
                />
            </svg>
        </div>
    );
}
