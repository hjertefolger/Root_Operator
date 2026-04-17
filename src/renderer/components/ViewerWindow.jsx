import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader } from 'lucide-react';
import AttachmentViewerOverlay from '../../client/components/AttachmentViewerOverlay';

function buildAttachmentCacheSeed(attachments) {
  const nextCache = {};

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment?.id && attachment?.bytesBase64 && attachment?.mime) {
      nextCache[attachment.id] = {
        bytesBase64: attachment.bytesBase64,
        mime: attachment.mime,
      };
    }
  }

  return nextCache;
}

async function serializeFile(file) {
  const buffer = await file.arrayBuffer();

  return {
    filename: file.name || 'attachment.png',
    mimeType: file.type || 'application/octet-stream',
    data: Array.from(new Uint8Array(buffer)),
  };
}

function ViewerWindow() {
  const [viewerState, setViewerState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [attachmentCache, setAttachmentCache] = useState({});
  const [attachmentFetchState, setAttachmentFetchState] = useState({});
  const attachmentRequestPromisesRef = useRef(new Map());

  useEffect(() => {
    let mounted = true;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousBodyMargin = document.body.style.margin;

    document.documentElement.classList.add('dark');
    document.body.style.backgroundColor = '#0a0b10';
    document.body.style.margin = '0';

    async function loadViewerState() {
      try {
        const result = await window.electronAPI?.viewer?.getState?.();
        if (!mounted) {
          return;
        }

        if (!result?.success) {
          throw new Error(result?.error || 'Attachment viewer failed to load');
        }

        const attachments = Array.isArray(result.attachments) ? result.attachments : [];
        setViewerState({
          attachments,
          externalRef: result.externalRef || null,
          initialIndex: Number.isInteger(result.initialIndex) ? result.initialIndex : 0,
          parentChatId: result.parentChatId || null,
        });
        setAttachmentCache(buildAttachmentCacheSeed(attachments));
      } catch (error) {
        if (!mounted) {
          return;
        }
        setLoadError(error?.message || 'Attachment viewer failed to load');
      }
    }

    loadViewerState();

    return () => {
      mounted = false;
      attachmentRequestPromisesRef.current.clear();
      document.body.style.backgroundColor = previousBodyBackground;
      document.body.style.margin = previousBodyMargin;
    };
  }, []);

  const requestAttachmentBytes = useCallback(async ({ attachment, externalRef }) => {
    const attachmentId = attachment?.id;
    if (!attachmentId) {
      throw new Error('Attachment id missing');
    }

    if (attachment.bytesBase64 && attachment.mime) {
      return {
        bytesBase64: attachment.bytesBase64,
        mime: attachment.mime,
      };
    }

    if (attachmentCache[attachmentId]?.bytesBase64) {
      return attachmentCache[attachmentId];
    }

    const existingRequest = attachmentRequestPromisesRef.current.get(attachmentId);
    if (existingRequest) {
      return existingRequest;
    }

    setAttachmentFetchState((prev) => ({
      ...prev,
      [attachmentId]: { loading: true, error: '' },
    }));

    const request = window.electronAPI.invoke('FETCH_LOCAL_CHAT_ATTACHMENT_BYTES', {
      attachmentId,
      externalRef,
    }).then((result) => {
      if (!result?.success || !result?.bytesBase64) {
        throw new Error(result?.error || 'Image unavailable');
      }

      const resolvedAttachment = {
        bytesBase64: result.bytesBase64,
        mime: result.mime || attachment.mime || '',
      };

      setAttachmentCache((prev) => ({
        ...prev,
        [attachmentId]: resolvedAttachment,
      }));
      setAttachmentFetchState((prev) => ({
        ...prev,
        [attachmentId]: { loading: false, error: '' },
      }));

      return resolvedAttachment;
    }).catch((error) => {
      setAttachmentFetchState((prev) => ({
        ...prev,
        [attachmentId]: { loading: false, error: error.message || 'Image unavailable' },
      }));
      throw error;
    }).finally(() => {
      attachmentRequestPromisesRef.current.delete(attachmentId);
    });

    attachmentRequestPromisesRef.current.set(attachmentId, request);
    return request;
  }, [attachmentCache]);

  const handleAnnotatedAttachment = useCallback(async (file) => {
    const payload = await serializeFile(file);
    const result = await window.electronAPI?.viewer?.annotated?.(payload);

    if (!result?.success) {
      throw new Error(result?.error || 'Failed to return annotated image');
    }
  }, []);

  const handleSendBackAttachment = useCallback(async (file) => {
    const payload = await serializeFile(file);
    const result = await window.electronAPI?.viewer?.sendBack?.(payload);

    if (!result?.success) {
      throw new Error(result?.error || 'Failed to send image back to chat');
    }
  }, []);

  const handleClose = useCallback(async () => {
    const result = await window.electronAPI?.viewer?.close?.();
    if (!result?.success) {
      window.close();
    }
  }, []);

  if (!viewerState && !loadError) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0b10',
          color: 'rgba(255,255,255,0.7)',
          gap: 10,
          fontSize: 13,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}
      >
        <Loader size={14} strokeWidth={2} className="animate-spin" style={{ color: '#4B5AFF' }} />
        <span>Loading attachment viewer</span>
      </div>
    );
  }

  if (loadError || !viewerState) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#0a0b10',
          color: 'rgba(255,255,255,0.7)',
          fontSize: 13,
          lineHeight: 1.5,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          textAlign: 'center',
        }}
      >
        {loadError || 'Attachment viewer unavailable'}
      </div>
    );
  }

  return (
    <AttachmentViewerOverlay
      attachments={viewerState.attachments}
      externalRef={viewerState.externalRef}
      initialIndex={viewerState.initialIndex}
      attachmentCache={attachmentCache}
      attachmentFetchState={attachmentFetchState}
      onRequestAttachment={requestAttachmentBytes}
      onQueueAnnotatedAttachment={handleAnnotatedAttachment}
      onSendAnnotatedAttachment={handleSendBackAttachment}
      onClose={handleClose}
    />
  );
}

export default ViewerWindow;
