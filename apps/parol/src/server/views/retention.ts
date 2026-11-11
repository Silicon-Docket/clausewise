/**
 * The numbers of the retention field on the new-matter form (package W2.7).
 *
 * The form is a page, and a page may not import the store (test/pages/static.test.ts), so it cannot
 * read `DEFAULT_RETAIN_DAYS` and `MAX_RETAIN_DAYS` from where the store keeps them. These two are
 * written here for it, and a test (test/pages/retention-page.test.ts) fails when either differs
 * from the store's, so an edit of the ceiling in one place cannot be missed in the other. The
 * matter page does not use them: the service puts the store's own numbers in `RetentionView`.
 */

/** The days the new-matter form offers: the store's default. */
export const FORM_RETAIN_DEFAULT_DAYS = 30;

/** The most days the new-matter form accepts: the store's ceiling. */
export const FORM_RETAIN_MAX_DAYS = 90;
