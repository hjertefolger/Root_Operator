/**
 * ROOT OPERATOR - CHAT STORE
 * JSONL-based append-only chat message store with rotation.
 * Persists channel messages to disk so they survive app restarts
 * and are reliably sent to reconnecting clients.
 */
const fs = require('fs');
const path = require('path');
const { stripAttachmentBytes } = require('./outbound-attachments');

const MAX_MESSAGES = 200;

class ChatStore {
    constructor(userDataPath, filename = 'channel-history.jsonl') {
        this.filePath = path.join(userDataPath, filename);
        this.tmpPath = this.filePath + '.tmp';
        this._appendCount = 0;
        // In-memory index for O(1) lookups by external_ref.
        // Built lazily on first findByExternalRef() call.
        this._externalRefIndex = null;
    }

    /**
     * Append a single message. O_APPEND ensures atomic writes under block size.
     */
    appendMessage(msg) {
        const line = JSON.stringify(msg) + '\n';
        try {
            fs.appendFileSync(this.filePath, line, { encoding: 'utf8' });
        } catch (err) {
            if (err.code === 'ENOENT') {
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.appendFileSync(this.filePath, line, { encoding: 'utf8' });
            }
        }
    }

    /**
     * Read all messages. Skips blank/corrupted lines.
     */
    loadMessages() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }

        const messages = [];
        const lines = raw.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                messages.push(JSON.parse(trimmed));
            } catch {
                // Corrupted line from crash — skip
            }
        }
        return messages;
    }

    /**
     * Atomic truncation: write to tmp then rename.
     */
    truncateIfNeeded() {
        const messages = this.loadMessages();
        if (messages.length <= MAX_MESSAGES) return [];

        const evicted = messages.slice(0, -MAX_MESSAGES);
        const kept = messages.slice(-MAX_MESSAGES);
        const data = kept.map(m => JSON.stringify(m)).join('\n') + '\n';
        try {
            fs.writeFileSync(this.tmpPath, data, { encoding: 'utf8' });
            fs.renameSync(this.tmpPath, this.filePath);
            this._externalRefIndex = null;
            return evicted;
        } catch {
            // Disk full or permission error — skip truncation, file stays longer
            return [];
        }
    }

    /**
     * Append + truncate every 50 writes.
     * @param {object} msg - message with role, content, ts
     * @param {object} [opts]
     * @param {string} [opts.externalRef] - stable attachment/reference token
     */
    addMessage(msg, { externalRef } = {}) {
        const sanitizedAttachments = stripAttachmentBytes(msg?.attachments);
        const normalized = sanitizedAttachments
            ? { ...msg, attachments: sanitizedAttachments }
            : { ...msg };
        const record = externalRef ? { ...normalized, external_ref: externalRef } : normalized;
        this.appendMessage(record);
        // Invalidate the in-memory index so the next lookup rebuilds it.
        this._externalRefIndex = null;
        this._appendCount++;
        let evicted = [];
        if (this._appendCount % 50 === 0) {
            evicted = this.truncateIfNeeded();
        }
        return { record, evicted };
    }

    /**
     * Find a message by its external_ref.
     * Returns the message object or null.
     */
    findByExternalRef(ref) {
        if (!ref) return null;
        if (!this._externalRefIndex) {
            this._externalRefIndex = new Map();
            for (const msg of this.loadMessages()) {
                if (msg.external_ref) {
                    this._externalRefIndex.set(msg.external_ref, msg);
                }
            }
        }
        return this._externalRefIndex.get(ref) || null;
    }

    /**
     * Clear all history (explicit user action only).
     */
    clear() {
        try {
            fs.unlinkSync(this.filePath);
        } catch {}
        this._appendCount = 0;
        this._externalRefIndex = null;
    }
}

module.exports = { ChatStore, MAX_MESSAGES };
