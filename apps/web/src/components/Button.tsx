import type { ComponentProps } from "react";

/**
 * A button that can be unavailable without being `disabled`. The browser takes the focus away from
 * a button that becomes disabled while it has it, so a keyboard user who presses Accept would find
 * the focus gone to the top of the page for as long as the change is being saved. This one says
 * `aria-disabled` instead: it keeps the focus, a screen reader still hears that it is unavailable,
 * and a click or a key press does nothing. Use it for any button that stops being available because
 * of what it just did; a button that is unavailable for a reason that does not depend on it can be
 * an ordinary disabled one.
 */
export function Button(props: ComponentProps<"button"> & { unavailable?: boolean }) {
  const { unavailable = false, onClick, type = "button", ...rest } = props;
  return (
    <button
      type={type}
      {...rest}
      aria-disabled={unavailable ? true : undefined}
      onClick={(event) => {
        if (unavailable) {
          // A submit button would otherwise still send its form.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
