/**
 * Frontmost-application probe for the Cursor Presence envelope.
 *
 * Uses `/usr/bin/lsappinfo` — a macOS-bundled utility that requires no
 * TCC permissions (no Accessibility, no Automation, no Screen
 * Recording). Returns the frontmost user-visible app's name and bundle
 * identifier, or null on failure.
 *
 * Implementation note: the cursor companion window is an NSPanel. While
 * the panel has key focus to receive keystrokes, it does NOT change the
 * frontmost application in the lsappinfo sense — that stays on the
 * underlying app the user invoked from. So calling getActiveApp() at
 * any time while the input pill is open returns the right answer
 * (Slack, Safari, Cursor, etc.), not Root_Operator itself.
 *
 * The TOTAL_DEADLINE_MS budget covers BOTH lsappinfo calls combined —
 * cursor submit shouldn't be delayed by more than this for context.
 */
const { spawn } = require('child_process');

const LSAPPINFO = '/usr/bin/lsappinfo';
const TOTAL_DEADLINE_MS = 250;

function execProbe(args, deadlineAt) {
    return new Promise((resolve) => {
        const remaining = Math.max(0, deadlineAt - Date.now());
        if (remaining <= 0) {
            resolve(null);
            return;
        }
        let stdout = '';
        let settled = false;
        const proc = spawn(LSAPPINFO, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            settled = true;
            try { proc.kill('SIGKILL'); } catch (_) {}
            resolve(null);
        }, remaining);
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
        });
        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(code === 0 ? stdout : null);
        });
    });
}

function parseField(out, key) {
    if (!out) return null;
    // lsappinfo info output: `"<KEY>"="<VALUE>"` per line. Bind the
    // value capture to end-of-line so embedded quotes inside the value
    // don't truncate it; collapse trailing whitespace/quote.
    const re = new RegExp(`^"${key}"="(.*)"\\s*$`, 'm');
    const match = out.match(re);
    return match ? match[1] : null;
}

function sanitize(value) {
    if (typeof value !== 'string') return null;
    // Collapse control chars + angle brackets so a hostile or just
    // weird app name can't reshape the system-reminder envelope.
    const cleaned = value
        .replace(/[\r\n\t<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

async function getActiveApp() {
    if (process.platform !== 'darwin') return null;
    const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
    const asnRaw = await execProbe(['front'], deadlineAt);
    const asn = asnRaw ? asnRaw.trim() : '';
    if (!asn || !asn.startsWith('ASN:')) return null;
    const info = await execProbe(['info', '-only', 'name', '-only', 'bundleid', asn], deadlineAt);
    if (!info) return null;
    const name = sanitize(parseField(info, 'LSDisplayName'));
    const bundleId = sanitize(parseField(info, 'CFBundleIdentifier'));
    if (!name && !bundleId) return null;
    return { name: name || null, bundleId: bundleId || null };
}

module.exports = { getActiveApp };
