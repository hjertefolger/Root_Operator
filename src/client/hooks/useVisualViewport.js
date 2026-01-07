import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook to track the visual viewport height on iOS.
 * Uses the VisualViewport API to get the actual visible height,
 * which shrinks when the virtual keyboard is open.
 *
 * Includes debouncing to prevent flickering from rapid viewport changes.
 */
export function useVisualViewport() {
  const [viewportHeight, setViewportHeight] = useState(null);
  const rafRef = useRef(null);
  const lastHeightRef = useRef(0);

  const updateViewport = useCallback(() => {
    // Cancel any pending RAF to debounce rapid updates
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;

      // Use the visual viewport height (accounts for keyboard)
      const newHeight = Math.round(viewport.height);

      // Only update if there's a meaningful change (> 10px to reduce jitter)
      if (Math.abs(newHeight - lastHeightRef.current) > 10) {
        lastHeightRef.current = newHeight;
        setViewportHeight(newHeight);
      }
    });
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    // Initial check
    updateViewport();

    // Listen to viewport changes
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);

    return () => {
      viewport.removeEventListener('resize', updateViewport);
      viewport.removeEventListener('scroll', updateViewport);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updateViewport]);

  return { viewportHeight };
}
