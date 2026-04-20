/**
 * ROOT OPERATOR - CHANNEL MANAGER
 * IPC client that connects the Electron main process to the channel-bridge
 * Unix socket. Forwards decrypted client messages to the bridge and receives
 * Claude's replies to send back to the PWA client.
 */
const net = require('net');
const EventEmitter = require('events');

class ChannelManager extends EventEmitter {
    constructor(ipcPath) {
        super();
        this.ipcPath = ipcPath || '/tmp/root-operator-channel.sock';
        this.socket = null;
        this.buffer = '';
        this.connected = false;
        this.reconnectTimer = null;
        this._destroyed = false;
        this.pendingMessages = [];
        this.maxPendingMessages = 100;
        this.bridgeReady = false;
        this.lastBridgeReadyTs = null;
    }

    connect() {
        if (this._destroyed) return;
        this._clearReconnect();

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }

        this.socket = net.createConnection(this.ipcPath, () => {
            this.connected = true;
            this._flushPending();
            this.emit('connected');
            console.log('[ChannelManager] Connected to channel bridge');
        });

        this.socket.on('data', (data) => {
            this.buffer += data.toString();
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    this.handleBridgeMessage(msg);
                } catch (e) {
                    console.error('[ChannelManager] Invalid message:', e.message);
                }
            }
        });

        this.socket.on('close', () => {
            const wasConnected = this.connected;
            this.connected = false;
            this.bridgeReady = false;
            if (wasConnected) {
                console.log('[ChannelManager] Disconnected from bridge');
                this.emit('disconnected');
            }
            this._scheduleReconnect();
        });

        this.socket.on('error', (error) => {
            this.emit('socket_error', error);
        });
    }

    _scheduleReconnect() {
        if (this._destroyed) return;
        this._clearReconnect();
        this.emit('reconnecting');
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    }

    _clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    handleBridgeMessage(msg) {
        if (msg.type === 'claude_reply') {
            this.emit('claude_reply', {
                chat_id: msg.chat_id,
                text: msg.text,
                attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
                ts: msg.ts,
            });
            return;
        }

        if (msg.type === 'claude_activity') {
            this.emit('claude_activity', {
                phase: msg.phase,
                label: msg.label,
                detail: msg.detail,
                toolName: msg.toolName || '',
                ts: msg.ts,
            });
            return;
        }

        if (msg.type === 'scheduler_request') {
            this.emit('scheduler_request', {
                callId: msg.callId,
                tool: msg.tool,
                args: msg.args,
                ts: msg.ts,
            });
            return;
        }

        if (msg.type === 'bridge_ready') {
            this.bridgeReady = true;
            this.lastBridgeReadyTs = Date.now();
            console.log(`[ChannelManager] Bridge ready (pid=${msg.pid || '?'})`);
            this.emit('bridge_ready', { pid: msg.pid, ts: msg.ts });
        }
    }

    _queuePayload(payload) {
        if (this.pendingMessages.length >= this.maxPendingMessages) {
            this.pendingMessages.shift();
        }
        this.pendingMessages.push(payload);
    }

    _flushPending() {
        if (!this.socket || !this.connected || this.pendingMessages.length === 0) {
            return;
        }

        while (this.pendingMessages.length > 0) {
            this.socket.write(this.pendingMessages.shift());
        }
    }

    sendToChannel(chatId, content, userId) {
        const payload = JSON.stringify({
            type: 'client_message',
            chat_id: chatId,
            content,
            user_id: userId || chatId,
            ts: new Date().toISOString(),
        }) + '\n';

        if (!this.socket || !this.connected) {
            this._queuePayload(payload);
            return false;
        }

        this.socket.write(payload);
        return true;
    }

    sendToChannelUnbuffered(chatId, content, userId) {
        const payload = JSON.stringify({
            type: 'client_message',
            chat_id: chatId,
            content,
            user_id: userId || chatId,
            ts: new Date().toISOString(),
        }) + '\n';

        if (!this.socket || !this.connected) {
            return false;
        }

        try {
            this.socket.write(payload);
        } catch {
            return false;
        }
        return true;
    }

    sendSchedulerResponse(callId, result, isError = false) {
        const payload = JSON.stringify({
            type: 'scheduler_response',
            callId,
            result,
            isError,
        }) + '\n';

        if (!this.socket || !this.connected) {
            return false;
        }

        this.socket.write(payload);
        return true;
    }

    disconnect() {
        this._destroyed = true;
        this._clearReconnect();
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
        }
        this.socket = null;
        this.connected = false;
    }
}

module.exports = { ChannelManager };
