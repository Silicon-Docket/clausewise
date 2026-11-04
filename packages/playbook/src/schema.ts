import { z } from "zod";

export const SEVERITIES = ["high", "medium", "low"] as const;

// Everything that draws nothing: white space and line breaks, control and format characters
// (zero-width space and joiners, bidi marks, soft hyphen, byte order mark), code points that
// renderers ignore by default (variation selectors, tag characters, fillers), combining marks
// with no base character, and the blank braille pattern.
const INVISIBLE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** True when the text has at least one character a reader can see. */
export function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE, "") !== "";
}

// A title or name that is blank to the eye still passes min(1), and then shows up as an empty
// heading in the report and an unlabelled finding in Word.
const visible = z
  .string()
  .refine(hasVisibleText, "must contain a visible character, not only spaces or invisible ones");

export const EscalateWhenSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  text: visible,
});

export const RuleSchema = z.strictObject({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "use lowercase letters, digits and hyphens, starting with a letter or digit",
    ),
  title: visible,
  severity: z.enum(SEVERITIES),
  /**
   * "presence" (the default): the contract should contain a clause that meets the standard.
   * "absence": the standard forbids something, so a contract that does not contain it passes.
   */
  kind: z.enum(["presence", "absence"]).optional(),
  /** When true, a contract with no clause on this topic is reported as missing. */
  required: z.boolean().default(false),
  /** The position we want to see. */
  standard: visible,
  /** A position we can live with if the standard is refused. */
  fallback: visible.optional(),
  /** What must be flagged and pushed back on. */
  unacceptable: visible.optional(),
  /** Free-form advice on how to word a fix. It is not a further test of the standard. */
  guidance: visible.optional(),
  /** Which part of the agreement the rule belongs to. Several rules may share a category. */
  category: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens")
    .optional(),
  /**
   * Approved wording a reviewer may offer when the standard is not met. Unlike `fallback`, which
   * describes a position, this is text, so a tool can show it verbatim or adapt it.
   */
  fallbackLanguage: visible.optional(),
  /** Situations that go to an attorney whatever the status, each with a stable id to cite. */
  escalateWhen: z.array(EscalateWhenSchema).optional(),
});

export const PlaybookSchema = z
  .strictObject({
    name: visible,
    /** Semantic version of this playbook, such as 1.0.0. Tools that pin a version require it. */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "use three numbers separated by dots, such as 1.0.0")
      .optional(),
    description: visible.optional(),
    contractTypes: z.array(visible).min(1),
    /**
     * Who "we" are, in terms a reader of the contract can apply, then what we care about. For
     * example "We are the party receiving most of the information, usually called the Recipient
     * or Receiving Party." The review prompt names the client separately.
     */
    perspective: visible,
    rules: z.array(RuleSchema).min(1),
  })
  .superRefine((playbook, ctx) => {
    const seen = new Set<string>();
    playbook.rules.forEach((rule, i) => {
      if (rule.kind === "absence" && rule.required) {
        ctx.addIssue({
          code: "custom",
          message: `rule "${rule.id}" is an absence rule, which passes when the clause is not there, so it cannot be required`,
          path: ["rules", i, "required"],
        });
      }
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate rule id "${rule.id}"`,
          path: ["rules", i, "id"],
        });
      }
      seen.add(rule.id);
      const escalationIds = new Set<string>();
      rule.escalateWhen?.forEach((item, j) => {
        if (escalationIds.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate escalateWhen id "${item.id}" in rule "${rule.id}"`,
            path: ["rules", i, "escalateWhen", j, "id"],
          });
        }
        escalationIds.add(item.id);
      });
    });
  });

export type Rule = z.infer<typeof RuleSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
export type Severity = (typeof SEVERITIES)[number];
