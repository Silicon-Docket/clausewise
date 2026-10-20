import { useMemo } from "react";
import { diffWords } from "../lib/diff.js";

/**
 * The paragraph an edit sits in, with the edit shown inside it: unchanged words plain, removed
 * words struck through, added words underlined. The server says where the removed words sit
 * (`start` and `end` into `paragraphText`); the text before and after is shown as it is and only
 * the words between are compared. If the stored position does not point at the words it claims to
 * (a changed file, a bug), nothing is guessed: both wordings are shown side by side instead.
 */
export function DiffView(props: {
  paragraphText: string;
  start: number;
  end: number;
  /** The words the edit removes. */
  original: string;
  /** The wording the edit puts there. */
  replacement: string;
}) {
  const { paragraphText, start, end, original, replacement } = props;

  const fits =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start <= end &&
    end <= paragraphText.length &&
    paragraphText.slice(start, end) === original;

  const diff = useMemo(
    () => (fits ? diffWords(original, replacement) : null),
    [fits, original, replacement],
  );

  if (!fits || diff === null) {
    return (
      <div className="diff diff-apart">
        <p className="diff-note">
          The words to change could not be found where the review recorded them, so the two wordings
          are shown next to each other instead of inside the paragraph. Check the paragraph in the
          original file before you accept.
        </p>
        <p className="field-label">Original wording</p>
        <p className="document-text">{original}</p>
        <p className="field-label">Suggested wording</p>
        <p className="document-text">
          {replacement === "" ? "(the words are removed)" : replacement}
        </p>
      </div>
    );
  }

  const unchanged = original === replacement;
  return (
    <div className="diff">
      <p className="document-text diff-text">
        {paragraphText.slice(0, start)}
        {diff.parts.map((part, index) => {
          if (part.kind === "delete") {
            return (
              <del key={index}>
                <span className="visually-hidden">Removed: </span>
                {part.text}
              </del>
            );
          }
          if (part.kind === "insert") {
            return (
              <ins key={index}>
                <span className="visually-hidden">Added: </span>
                {part.text}
              </ins>
            );
          }
          return <span key={index}>{part.text}</span>;
        })}
        {paragraphText.slice(end)}
      </p>
      {unchanged ? (
        <p className="diff-note">
          This wording is the same as the original, so no tracked change will be written. The
          comment is still added.
        </p>
      ) : replacement === "" ? (
        <p className="diff-note">This removes the words and puts nothing in their place.</p>
      ) : null}
      {diff.approximate ? (
        <p className="diff-note">
          This passage is too long to compare word by word, so all of it is shown as replaced.
        </p>
      ) : null}
      <p className="diff-legend" aria-hidden="true">
        <span className="legend-removed">Struck through</span> is removed.{" "}
        <span className="legend-added">Underlined</span> is added.
      </p>
    </div>
  );
}
