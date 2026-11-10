import type { RetentionView } from "../../services/views.js";
import type { Chrome } from "./layout.js";

/**
 * The retention date of a matter, as a section of the matter page (package W2.7): how long the
 * matter is kept, whether it is past its date, and, for an associate, the form that changes it.
 *
 * Contract commit CC1: the props and the place in the page are final; the section renders nothing
 * until W2.7 fills it. The file name is letters only because a page may import another page only
 * by such a name (the static test).
 */
export interface RetentionSectionProps {
  chrome: Chrome;
  matterId: string;
  /** From `MatterView.retention`. Absent when the service did not fill it. */
  retention: RetentionView | undefined;
  /** Whether the signed-in person's role on the matter allows `matter.update`. */
  canUpdate: boolean;
}

export function RetentionSection(_props: RetentionSectionProps) {
  // STUB(W2.7): renders nothing. W2.7 returns the section with id "retention" here.
  return null;
}
