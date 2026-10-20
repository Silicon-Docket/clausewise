import type { FileChooser, Locator, Page } from "@playwright/test";

/** What has the focus, in words a failing test can print: its tag, its name and where it sits. */
export async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return "the page itself";
    const label =
      el.getAttribute("aria-label") ??
      (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 50) ??
      "";
    const card = el.closest("article")?.getAttribute("aria-labelledby");
    const title =
      card === null || card === undefined ? "" : document.getElementById(card)?.textContent;
    return `<${el.tagName.toLowerCase()}> "${label}"${title ? ` in the card "${title}"` : ""}`;
  });
}

/** True when the first element the locator finds has the focus. */
export async function hasFocus(target: Locator): Promise<boolean> {
  return target
    .first()
    .evaluate((el) => el === el.ownerDocument.activeElement, undefined, { timeout: 2000 })
    .catch(() => false);
}

/**
 * Presses Tab (or Shift+Tab) until the element has the focus, and says how many presses it took.
 * It gives up after `max` presses with a message that says where the focus is, because a keyboard
 * user who cannot reach a control is a defect, and "timeout" would not say which.
 */
export async function pressTabUntil(
  page: Page,
  target: Locator,
  options: { backwards?: boolean; max?: number } = {},
): Promise<number> {
  const key = options.backwards === true ? "Shift+Tab" : "Tab";
  const max = options.max ?? 80;
  for (let presses = 0; presses <= max; presses += 1) {
    if (await hasFocus(target)) return presses;
    await page.keyboard.press(key);
  }
  throw new Error(
    `The focus did not reach ${target.toString()} in ${max} presses of ${key}. It is on ${await describeFocus(page)}.`,
  );
}

/**
 * The names of the controls that Tab visits, in order, starting from where the focus is now. It
 * stops after `count` presses. For a test that wants to know the order and not only the target.
 */
export async function tabOrder(page: Page, count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let press = 0; press < count; press += 1) {
    await page.keyboard.press("Tab");
    seen.push(await describeFocus(page));
  }
  return seen;
}

/**
 * How the focus is drawn: the width of its outline and whether it has one at all. A control that
 * has the focus and shows nothing is invisible to a person who cannot use a mouse.
 */
export async function focusRing(
  target: Locator,
): Promise<{ style: string; widthPx: number; color: string; offsetPx: number }> {
  return target.first().evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      style: css.outlineStyle,
      widthPx: Number.parseFloat(css.outlineWidth),
      color: css.outlineColor,
      offsetPx: Number.parseFloat(css.outlineOffset),
    };
  });
}

/**
 * Listens for the file chooser from now on. Call it as soon as the page exists, long before the key
 * that opens the chooser is pressed: Playwright switches the interception on with a message to the
 * browser, and a key pressed before that message has arrived opens the real dialog, which nobody
 * sees, and the test waits for an event that never comes.
 */
export function listenForFileChooser(page: Page): {
  next(timeoutMs?: number): Promise<FileChooser>;
} {
  const arrived: FileChooser[] = [];
  const waiting: Array<(chooser: FileChooser) => void> = [];
  page.on("filechooser", (chooser) => {
    const waiter = waiting.shift();
    if (waiter === undefined) arrived.push(chooser);
    else waiter(chooser);
  });
  return {
    next(timeoutMs = 10_000) {
      const early = arrived.shift();
      if (early !== undefined) return Promise.resolve(early);
      return new Promise<FileChooser>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No file chooser opened in ${timeoutMs} ms.`)),
          timeoutMs,
        );
        waiting.push((chooser) => {
          clearTimeout(timer);
          resolve(chooser);
        });
      });
    },
  };
}
