"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

export interface LiveEvent {
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

export function useLiveReload(
  enabled: boolean,
  onReload: () => void,
  delayMs = 1200,
  shouldReload?: (event: LiveEvent) => boolean
) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const url = api.streamUrl();
    if (!url) return;

    const stream = new EventSource(url);
    stream.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      if (shouldReload && !shouldReload(event)) return;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => onReload(), delayMs);
    };

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      stream.close();
    };
  }, [enabled, onReload, delayMs, shouldReload]);
}
