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
import { useEffect, useState } from 'react';

const ACCENT = '#4B5AFF';

export default function AgentHaloView() {
    const [visible, setVisible] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        if (!window.electronAPI || typeof window.electronAPI.on !== 'function') return;
        const unsubShow = window.electronAPI.on('AGENT_HALO_SHOW', (payload) => {
            if (payload && Number.isFinite(payload.width) && Number.isFinite(payload.height)) {
                setSize({ width: payload.width, height: payload.height });
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

    // PAD must match agent-halo.js — render assumes the window is the
    // element frame plus this padding on each side.
    const PAD = 14;
    const innerWidth = Math.max(0, size.width - PAD * 2);
    const innerHeight = Math.max(0, size.height - PAD * 2);

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
                transition: 'opacity 220ms ease-out',
            }}
        >
            {/* Outer soft glow */}
            <div
                style={{
                    position: 'absolute',
                    left: PAD - 6,
                    top: PAD - 6,
                    width: innerWidth + 12,
                    height: innerHeight + 12,
                    borderRadius: 12,
                    background: 'transparent',
                    boxShadow: `0 0 18px 4px ${ACCENT}66, 0 0 38px 12px ${ACCENT}22`,
                }}
            />
            {/* Inner stroke */}
            <div
                style={{
                    position: 'absolute',
                    left: PAD,
                    top: PAD,
                    width: innerWidth,
                    height: innerHeight,
                    borderRadius: 8,
                    border: `1px solid ${ACCENT}AA`,
                    boxShadow: `inset 0 0 8px ${ACCENT}33`,
                }}
            />
        </div>
    );
}
