/**
 * AGENT AVATAR VIEW (v1.6 — cursor-as-home)
 *
 * Renders the agent's body — a single accent dot, centered in a small
 * transparent panel. Two visual states:
 *
 *   ambient   — small dot (6px), no ring; the resting state, attached
 *               to the user's cursor with a soft spring lag.
 *   active    — slightly bigger dot (10px) with a soft accent halo
 *               ring; signals "I'm engaged here."
 *   driving   — larger warm dot with a stronger ring while Presence
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
    // Ambient = 5px to match the legacy cursor-companion dot.
    // Active = 10px so the "engaged" state still reads bigger than rest.
    const dotSize = isDriving ? 14 : (isActive ? 10 : 5);
    const ringSize = isDriving ? 34 : (isActive ? 22 : 0);
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
            {/* Accent halo ring — fades in on active. */}
            <div
                style={{
                    position: 'absolute',
                    width: ringSize,
                    height: ringSize,
                    borderRadius: '50%',
                    background: `radial-gradient(circle, ${color}35 0%, ${color}00 70%)`,
                    opacity: (isActive || isDriving) ? 1 : 0,
                    transition: 'opacity 220ms ease-out, width 220ms ease-out, height 220ms ease-out',
                }}
            />
            {/* The dot itself. */}
            <div
                style={{
                    width: dotSize,
                    height: dotSize,
                    borderRadius: '50%',
                    backgroundColor: color,
                    boxShadow: (isActive || isDriving)
                        ? `0 0 ${isDriving ? 14 : 8}px ${color}66, 0 0 2px ${color}`
                        : 'none',
                    transition: 'width 160ms ease-out, height 160ms ease-out, box-shadow 160ms ease-out, background-color 160ms ease-out',
                }}
            />
        </div>
    );
}
