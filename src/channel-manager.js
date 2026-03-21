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

        // Only schedule retry from close — error always precedes close
        this.socket.on('close', () => {
            const wasConnected = this.connected;
            this.connected = false;
            if (wasConnected) {
                console.log('[ChannelManager] Disconnected from bridge');
            }
            this._scheduleReconnect();
        });

        this.socket.on('error', () => {
            // Swallow — close fires after error and handles retry
        });
    }

    _scheduleReconnect() {
        if (this._destroyed) return;
        this._clearReconnect();
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
                ts: msg.ts,
            });
        }
    }

    sendToChannel(chatId, content, userId) {
        if (!this.socket || !this.connected) {
            return false;
        }

        const payload = JSON.stringify({
            type: 'client_message',
            chat_id: chatId,
            content,
            user_id: userId || chatId,
            ts: new Date().toISOString(),
        });

        this.socket.write(payload + '\n');
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
