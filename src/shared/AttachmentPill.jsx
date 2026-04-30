/**
 * Shared file-attachment pill.
 *
 * Used by:
 *   - src/client/components/ChannelChat.jsx     (web/PWA chat — replies + composer)
 *   - src/renderer/components/CursorCompanionView.jsx (Electron Cursor Presence — pending annotation queued for next submit)
 *
 * Visual contract is intentionally fixed: matching exactly the original
 * ChannelChat AttachmentPill so PWA chat stays pixel-perfect across the
 * extraction. Layout/typography/colour decisions changed here would
 * affect both surfaces — change deliberately.
 */
import React from 'react';

const MONO = "'SF Mono','Menlo','Consolas','Liberation Mono',monospace";

export function splitFileNameExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toUpperCase() };
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPill({ name, size, icon, onClick, disabled, onContextMenu }) {
  const { stem, ext } = splitFileNameExt(name);
  const isButton = typeof onClick === 'function';
  const sharedInner = (
    <>
      <span style={{ display: 'inline-flex', flexShrink: 0, color: '#4B5AFF' }}>{icon}</span>
      <span style={{
        fontSize: 13,
        color: 'rgba(255,255,255,0.55)',
        fontFamily: MONO,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        flex: 1,
      }}>
        {stem}
      </span>
      {ext && (
        <span style={{ fontSize: 13, color: '#4B5AFF', fontFamily: MONO, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {ext}
        </span>
      )}
      {size != null && (
        <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', fontFamily: MONO, flexShrink: 0 }}>
          {formatFileSize(size)}
        </span>
      )}
    </>
  );

  const sharedStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'transparent',
    textAlign: 'left',
    width: '100%',
    minWidth: 0,
  };

  if (isButton) {
    return (
      <button
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        disabled={disabled}
        style={{ ...sharedStyle, color: 'inherit', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.72 : 1 }}
      >
        {sharedInner}
      </button>
    );
  }

  return <div style={sharedStyle} onContextMenu={onContextMenu}>{sharedInner}</div>;
}

export const ATTACHMENT_PILL_MONO = MONO;
