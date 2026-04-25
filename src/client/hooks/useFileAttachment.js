import { useState, useCallback, useRef } from 'react';

const CHUNK_SIZE = 512 * 1024; // 512 KB plaintext per chunk

// Per-category upload caps. Must stay in sync with the server's
// `maxFileSize` in src/main/websocket-bridge.js (currently 100 MB) and the
// composer accept caps + accepted-extension list in ChannelChat.jsx —
// otherwise the composer will accept a file that the upload path silently
// rejects.
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_PDF_SIZE = 25 * 1024 * 1024;
const MAX_TEXT_SIZE = 5 * 1024 * 1024;
const MAX_DEFAULT_SIZE = 10 * 1024 * 1024;

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm']);
const TEXT_EXTS = new Set([
  // Markdown / plain text
  'md', 'markdown', 'txt', 'log',
  // Data files commonly attached for inspection
  'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'env', 'ini', 'sql', 'xml',
  // Source code
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'html', 'htm', 'css', 'scss', 'sass', 'svg',
  'rb', 'go', 'rs', 'swift', 'kt', 'java',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
  'sh', 'bash', 'zsh',
]);

function fileExtension(name) {
  if (typeof name !== 'string') return '';
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

function capForFile(file) {
  const type = typeof file?.type === 'string' ? file.type.toLowerCase() : '';
  const ext = fileExtension(file?.name);

  if (type.startsWith('image/') || (!type && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'].includes(ext))) {
    return { bytes: MAX_IMAGE_SIZE, label: 'image' };
  }
  if (type.startsWith('video/') || VIDEO_EXTS.has(ext)) {
    return { bytes: MAX_VIDEO_SIZE, label: 'video' };
  }
  if (type === 'application/pdf' || ext === 'pdf') {
    return { bytes: MAX_PDF_SIZE, label: 'PDF' };
  }
  if (
    type === 'text/markdown' || type === 'text/x-markdown' || type === 'text/plain'
    || type.startsWith('text/') || type === 'application/json' || type === 'application/xml'
    || TEXT_EXTS.has(ext)
  ) {
    return { bytes: MAX_TEXT_SIZE, label: 'text file' };
  }
  return { bytes: MAX_DEFAULT_SIZE, label: 'file' };
}

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

    const cap = capForFile(file);
    if (file.size > cap.bytes) {
      const limitMb = Math.round(cap.bytes / 1024 / 1024);
      return {
        success: false,
        error: `${cap.label === 'file' ? 'File' : cap.label.charAt(0).toUpperCase() + cap.label.slice(1)} too large (max ${limitMb} MB)`,
      };
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
