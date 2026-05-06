/**
 * AGENT AVATAR VIEW (v1.6 — cursor-as-home)
 *
 * Renders the agent's body: a small presence dot centered in a
 * transparent panel. Engaged states add a tiny top-right dotted field
 * that echoes the halo grid without obscuring app content.
 *
 *   ambient   — small dot (5px), no field; the resting state, attached
 *               to the user's cursor with a soft spring lag.
 *   active    — slightly bigger dot (8px) with a sparse grid wake;
 *               signals "I'm engaged here."
 *   driving   — larger warm dot with a stronger grid wake while Presence
 *               is borrowing the HID cursor lane.
 *
 * Travelling renders the same as ambient — the motion does the talking.
 *
 * State arrives via IPC `AGENT_AVATAR_STATE` from the main process. We
 * default to ambient so a missed first broadcast doesn't render the
 * dot any larger than necessary.
 */
import { useEffect, useState } from 'react';

const ACCENT = '#4B5AFF';
const DRIVING = '#FF7A1A';

export default function AgentAvatarView() {
    const [agentState, setAgentState] = useState('ambient');

    useEffect(() => {
        if (!window.electronAPI || typeof window.electronAPI.on !== 'function') return;
        const unsub = window.electronAPI.on('AGENT_AVATAR_STATE', (payload) => {
            if (payload && typeof payload.state === 'string') {
                setAgentState(payload.state);
            }
        });
        return () => {
            if (typeof unsub === 'function') unsub();
        };
    }, []);

    const isActive = agentState === 'active';
    const isDriving = agentState === 'driving';
    const dotSize = isDriving ? 12 : (isActive ? 8 : 5);
    const fieldSize = isDriving ? 30 : (isActive ? 26 : 18);
    const fieldOpacity = isDriving ? 0.46 : (isActive ? 0.32 : 0);
    const washSize = isDriving ? 28 : (isActive ? 22 : 0);
    const color = isDriving ? DRIVING : ACCENT;

    return (
        <div
            style={{
                width: '100vw',
                height: '100vh',
                margin: 0,
                padding: 0,
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                position: 'relative',
            }}
        >
            <style>{`
                @keyframes agentAvatarGridTravel {
                    0%, 100% { transform: translate(1px, -1px); opacity: var(--grid-opacity-low); }
                    46% { transform: translate(-1px, 1px); opacity: var(--grid-opacity); }
                }
                @keyframes agentAvatarDotSettle {
                    0%, 100% { transform: scale(1); }
                    45% { transform: scale(1.045); }
                }
            `}</style>
            <div
                style={{
                    position: 'absolute',
                    top: isDriving ? 4 : 7,
                    right: isDriving ? 4 : 6,
                    width: fieldSize,
                    height: fieldSize,
                    backgroundImage: `radial-gradient(circle, ${color} 0, ${color} 1px, transparent 1.25px)`,
                    backgroundSize: isDriving ? '6px 6px' : '5px 5px',
                    backgroundPosition: 'top right',
                    opacity: fieldOpacity,
                    '--grid-opacity': fieldOpacity,
                    '--grid-opacity-low': fieldOpacity * 0.58,
                    WebkitMaskImage: 'radial-gradient(circle at 82% 18%, #000 0%, #000 22%, rgba(0,0,0,0.68) 42%, transparent 76%)',
                    maskImage: 'radial-gradient(circle at 82% 18%, #000 0%, #000 22%, rgba(0,0,0,0.68) 42%, transparent 76%)',
                    transition: 'opacity 180ms ease-out, width 180ms ease-out, height 180ms ease-out, background-size 180ms ease-out',
                    animation: 'agentAvatarGridTravel 3200ms ease-in-out infinite',
                }}
            />
            <div
                style={{
                    position: 'absolute',
                    width: washSize,
                    height: washSize,
                    borderRadius: '50%',
                    background: `radial-gradient(circle at 58% 45%, ${color}22 0%, ${color}00 70%)`,
                    opacity: (isActive || isDriving) ? 0.9 : 0,
                    transition: 'opacity 220ms ease-out, width 220ms ease-out, height 220ms ease-out',
                }}
            />
            <div
                style={{
                    width: dotSize,
                    height: dotSize,
                    borderRadius: '50%',
                    backgroundColor: color,
                    boxShadow: (isActive || isDriving)
                        ? `0 0 0 1px ${color}30, 0 0 ${isDriving ? 10 : 6}px ${color}55`
                        : 'none',
                    transition: 'width 160ms ease-out, height 160ms ease-out, box-shadow 160ms ease-out, background-color 160ms ease-out',
                    animation: (isActive || isDriving) ? 'agentAvatarDotSettle 2400ms ease-in-out infinite' : 'none',
                }}
            />
        </div>
    );
}
