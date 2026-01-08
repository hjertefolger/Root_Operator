import { useCallback, useRef, useEffect } from 'react';

const STORAGE_KEY = 'root_operator_terminal_state';
const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
const SAVE_DEBOUNCE_MS = 500;

/**
 * Hook for persisting terminal content to sessionStorage.
 *
 * Uses sessionStorage (not localStorage) for security:
 * - Clears when tab closes, reducing XSS exposure window
 * - Per-tab isolation prevents conflicts
 * - Terminal output may contain sensitive data
 */
export function useTerminalPersistence() {
  const saveTimeoutRef = useRef(null);
  const contentBufferRef = useRef('');

  /**
   * Save terminal content (debounced)
   */
  const saveContent = useCallback((content) => {
    contentBufferRef.current = content;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      try {
        // Truncate to max size (keep the end, which is most recent)
        const truncated = content.length > MAX_CONTENT_SIZE
          ? content.slice(-MAX_CONTENT_SIZE)
          : content;

        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          content: truncated,
          timestamp: Date.now()
        }));
      } catch (e) {
        // Quota exceeded or other storage error - fail silently
        console.warn('[Persistence] Failed to save terminal state:', e.message);
      }
    }, SAVE_DEBOUNCE_MS);
  }, []);

  /**
   * Load terminal content from sessionStorage
   */
  const loadContent = useCallback(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) return null;

      const { content } = JSON.parse(stored);
      return content || null;
    } catch (e) {
      console.warn('[Persistence] Failed to load terminal state:', e.message);
      return null;
    }
  }, []);

  /**
   * Clear stored content
   */
  const clearContent = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      contentBufferRef.current = '';
    } catch (e) {
      // Ignore errors
    }
  }, []);

  /**
   * Mark that we received server buffer (to avoid using stale sessionStorage)
   */
  const markServerBufferReceived = useCallback(() => {
    try {
      // Clear sessionStorage since server buffer is the source of truth
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // Ignore errors
    }
  }, []);

  /**
   * Get current content buffer (for immediate save on page hide)
   */
  const getContentBuffer = useCallback(() => {
    return contentBufferRef.current;
  }, []);

  // Save immediately on page hide (no debounce)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && contentBufferRef.current) {
        try {
          const truncated = contentBufferRef.current.length > MAX_CONTENT_SIZE
            ? contentBufferRef.current.slice(-MAX_CONTENT_SIZE)
            : contentBufferRef.current;

          sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
            content: truncated,
            timestamp: Date.now()
          }));
        } catch (e) {
          // Ignore errors
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return {
    saveContent,
    loadContent,
    clearContent,
    markServerBufferReceived,
    getContentBuffer
  };
}
