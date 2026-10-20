export { DEFAULT_LIMITS, DocxError, type DocxLimits } from "./ooxml.js";
export { inspectDocx, type DocxInspection } from "./inspect.js";
export { parseDocx, paragraphId, type DocxParagraph, type ParsedDocx } from "./parse.js";
export {
  applyRedline,
  type Comment,
  type Edit,
  type Outcome,
  type RedlineOptions,
  type RedlineResult,
} from "./redline.js";
