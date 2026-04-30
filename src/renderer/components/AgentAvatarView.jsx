/**
 * AGENT AVATAR VIEW (v0)
 *
 * Renders the agent's parked dot — a single static blue dot, centered
 * in a small transparent panel. v0 has no animations, no interactions,
 * no state. The dot just sits there, visible whenever Root Operator is
 * running. This is the lightest possible slice of co-presence: the
 * agent's body exists in the user's desktop world.
 */
const ACCENT = '#4B5AFF';
const DOT_SIZE = 6;

export default function AgentAvatarView() {
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
            }}
        >
            <div
                style={{
                    width: DOT_SIZE,
                    height: DOT_SIZE,
                    borderRadius: '50%',
                    backgroundColor: ACCENT,
                }}
            />
        </div>
    );
}
