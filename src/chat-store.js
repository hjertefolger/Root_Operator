/**
 * ROOT OPERATOR - CHAT STORE
 * JSONL-based append-only chat message store with rotation.
 * Persists channel messages to disk so they survive app restarts
 * and are reliably sent to reconnecting clients.
 */
const fs = require('fs');
const path = require('path');

const MAX_MESSAGES = 200;

class ChatStore {
    constructor(userDataPath, filename = 'channel-history.jsonl') {
        this.filePath = path.join(userDataPath, filename);
        this.tmpPath = this.filePath + '.tmp';
        this._appendCount = 0;
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
        if (messages.length <= MAX_MESSAGES) return;

        const kept = messages.slice(-MAX_MESSAGES);
        const data = kept.map(m => JSON.stringify(m)).join('\n') + '\n';
        try {
            fs.writeFileSync(this.tmpPath, data, { encoding: 'utf8' });
            fs.renameSync(this.tmpPath, this.filePath);
        } catch {
            // Disk full or permission error — skip truncation, file stays longer
        }
    }

    /**
     * Append + truncate every 50 writes.
     */
    addMessage(msg) {
        this.appendMessage(msg);
        this._appendCount++;
        if (this._appendCount % 50 === 0) {
            this.truncateIfNeeded();
        }
    }

    /**
     * Clear all history (explicit user action only).
     */
    clear() {
        try {
            fs.unlinkSync(this.filePath);
        } catch {}
        this._appendCount = 0;
    }
}

module.exports = { ChatStore, MAX_MESSAGES };
