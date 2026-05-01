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
 *
 * Travelling renders the same as ambient — the motion does the talking.
 *
 * State arrives via IPC `AGENT_AVATAR_STATE` from the main process. We
 * default to ambient so a missed first broadcast doesn't render the
 * dot any larger than necessary.
 */
import { useEffect, useState } from 'react';

const ACCENT = '#4B5AFF';

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
    const dotSize = isActive ? 10 : 6;
    const ringSize = isActive ? 22 : 0;

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
                    background: `radial-gradient(circle, ${ACCENT}22 0%, ${ACCENT}00 70%)`,
                    opacity: isActive ? 1 : 0,
                    transition: 'opacity 220ms ease-out, width 220ms ease-out, height 220ms ease-out',
                }}
            />
            {/* The dot itself. */}
            <div
                style={{
                    width: dotSize,
                    height: dotSize,
                    borderRadius: '50%',
                    backgroundColor: ACCENT,
                    boxShadow: isActive
                        ? `0 0 8px ${ACCENT}66, 0 0 2px ${ACCENT}`
                        : 'none',
                    transition: 'width 220ms ease-out, height 220ms ease-out, box-shadow 220ms ease-out',
                }}
            />
        </div>
    );
}
