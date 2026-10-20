/**
 * A native progress element, so that it is announced as one and needs no inline style. With no
 * total yet it is indeterminate.
 */
export function ProgressBar(props: { done: number; total: number; label: string }) {
  const { done, total, label } = props;
  return total > 0 ? (
    <progress className="progress" value={Math.min(done, total)} max={total} aria-label={label} />
  ) : (
    <progress className="progress" aria-label={label} />
  );
}
