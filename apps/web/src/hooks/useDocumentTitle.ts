import { useEffect } from "react";

/** Puts the screen's name in the browser tab, so that several open tabs can be told apart. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === "" ? "Clausewise" : `${title} - Clausewise`;
  }, [title]);
}
