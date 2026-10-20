"use client";

import { createContext, useContext, useRef, useState, type MutableRefObject, type ReactNode } from "react";

// What the notebook's margin shows: the passage behind a citation, or a whole source. The
// sources list and the chat sit in different parts of the page, so they share this state.
export type MarginItem =
  | { kind: "cite"; entryId: string; ordinal: number }
  | { kind: "source"; sourceId: string; title: string }
  | null;

interface Margin {
  item: MarginItem;
  open: (item: MarginItem, opener?: HTMLElement | null) => void;
  opener: MutableRefObject<HTMLElement | null>;
}

const MarginContext = createContext<Margin | null>(null);

export function MarginProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<MarginItem>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (next: MarginItem, from?: HTMLElement | null) => {
    if (from !== undefined) opener.current = from;
    setItem(next);
  };
  return <MarginContext.Provider value={{ item, open, opener }}>{children}</MarginContext.Provider>;
}

export function useMargin(): Margin {
  const margin = useContext(MarginContext);
  if (!margin) throw new Error("useMargin outside MarginProvider");
  return margin;
}
