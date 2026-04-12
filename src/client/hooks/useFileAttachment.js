import { useState, useCallback, useRef } from 'react';

const CHUNK_SIZE = 512 * 1024; // 512 KB plaintext per chunk
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export function useFileAttachment({ encryptBuffer, socket, e2eReady }) {
  const [uploadProgress, setUploadProgress] = useState(null); // null | { filename, percent }
  const abortRef = useRef(false);

  const sendFile = useCallback(async (file, caption) => {
    if (!e2eReady || !encryptBuffer || !socket || socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Not connected' };
    }

    if (!file) {
      return { success: false, error: 'No file selected' };
    }

    if (file.size > MAX_FILE_SIZE) {
      return { success: false, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` };
    }

    if (file.size === 0) {
      return { success: false, error: 'File is empty' };
    }

    abortRef.current = false;
    const transferId = crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

    setUploadProgress({ filename: file.name, percent: 0 });

    for (let i = 0; i < totalChunks; i++) {
      if (abortRef.current) {
        setUploadProgress(null);
        return { success: false, error: 'Aborted' };
      }

      const slice = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const encrypted = await encryptBuffer(slice);

      if (!encrypted) {
        setUploadProgress(null);
        return { success: false, error: 'Encryption failed' };
      }

      if (socket.readyState !== WebSocket.OPEN) {
        setUploadProgress(null);
        return { success: false, error: 'Connection lost during upload' };
      }

      const msg = {
        type: 'e2e_file_chunk',
        transferId,
        chunkIndex: i,
        totalChunks,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        ...encrypted,
      };
      // Include caption on the first chunk so the server can compose a single message
      if (i === 0 && caption) {
        msg.caption = caption;
      }
      socket.send(JSON.stringify(msg));

      setUploadProgress({ filename: file.name, percent: Math.round(((i + 1) / totalChunks) * 100) });

      // Yield between chunks to avoid saturating the WS write buffer
      if (i < totalChunks - 1) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    setUploadProgress(null);
    return { success: true, transferId };
  }, [encryptBuffer, socket, e2eReady]);

  const abortUpload = useCallback(() => {
    abortRef.current = true;
  }, []);

  return { sendFile, uploadProgress, isUploading: uploadProgress !== null, abortUpload };
}
