// STUB: replaced by the docx engine workstream.

/** What a Word file holds that the review does not show to the model. */
export interface DocxInspection {
  trackedInsertions: number;
  trackedDeletions: number;
  comments: number;
  footnotes: number;
  endnotes: number;
  /** Header and footer parts that contain any text. */
  headerFooterParts: number;
  /** Runs formatted as hidden text, which Word does not display. */
  hiddenRuns: number;
  images: number;
}

export async function inspectDocx(_buf: Uint8Array): Promise<DocxInspection> {
  return {
    trackedInsertions: 0,
    trackedDeletions: 0,
    comments: 0,
    footnotes: 0,
    endnotes: 0,
    headerFooterParts: 0,
    hiddenRuns: 0,
    images: 0,
  };
}
