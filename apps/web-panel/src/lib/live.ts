"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

export function useLiveReload(enabled: boolean, onReload: () => void, delayMs = 1200) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const url = api.streamUrl();
    if (!url) return;

    const stream = new EventSource(url);
    stream.onmessage = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => onReload(), delayMs);
    };

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      stream.close();
    };
  }, [enabled, onReload, delayMs]);
}
