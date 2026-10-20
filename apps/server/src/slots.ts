/**
 * A fixed number of places for work that holds memory while it runs. Taking a place never waits:
 * when none is free the caller is told at once and answers "try again". A place is given back by
 * calling the function that was handed out, and calling it twice gives back only one place, so a
 * cleanup that runs on two exit paths cannot free a place that now belongs to someone else.
 */
export interface Slots {
  /** A function that gives the place back, or undefined when every place is taken. */
  tryTake(): (() => void) | undefined;
  /** Places in use right now. */
  inUse(): number;
}

export function createSlots(size: number): Slots {
  let used = 0;
  return {
    tryTake() {
      if (used >= size) return undefined;
      used += 1;
      let given = false;
      return () => {
        if (given) return;
        given = true;
        used -= 1;
      };
    },
    inUse: () => used,
  };
}
