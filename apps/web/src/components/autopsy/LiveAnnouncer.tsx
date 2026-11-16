"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { toAnnouncement } from "@/lib/a11y/summary";

type Announce = (message: string) => void;

const AnnouncerContext = createContext<Announce>(() => {});

export function LiveAnnouncer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  // Clearing first makes a repeated identical message re-announce.
  const announce = useCallback<Announce>((m) => {
    setMessage("");
    queueMicrotask(() => setMessage(toAnnouncement(m)));
  }, []);
  const value = useMemo(() => announce, [announce]);
  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="true" role="status" className="sr-only" data-testid="live-announcer">
        {message}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}
