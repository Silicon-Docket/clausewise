import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/**
 * One polite live region for the whole app, so that a screen reader hears that a review finished or
 * that a decision was saved without the page moving focus. The region is always in the page, which
 * is what makes assistive technology notice a change in it.
 */

type Announce = (message: string) => void;

const AnnounceContext = createContext<Announce | null>(null);

export function AnnouncerProvider(props: { children: ReactNode }) {
  // Two slots, written in turn: a message identical to the last one is still a change in the
  // region, so it is read out again.
  const [slots, setSlots] = useState<[string, string]>(["", ""]);
  const turn = useRef<0 | 1>(0);

  const announce = useCallback<Announce>((message) => {
    turn.current = turn.current === 0 ? 1 : 0;
    setSlots(turn.current === 0 ? [message, ""] : ["", message]);
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      {props.children}
      <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
        <span>{slots[0]}</span>
        <span>{slots[1]}</span>
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  const announce = useContext(AnnounceContext);
  if (announce === null) throw new Error("AnnouncerProvider is missing above this component.");
  return announce;
}
