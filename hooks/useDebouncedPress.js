import { useRef, useCallback } from 'react';

const DEFAULT_DELAY = 500;

export function useDebouncedPress(handler, delay = DEFAULT_DELAY) {
  const lastPressRef = useRef(0);

  return useCallback((...args) => {
    const now = Date.now();
    if (now - lastPressRef.current < delay) return;
    lastPressRef.current = now;
    handler(...args);
  }, [handler, delay]);
}
