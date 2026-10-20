import { z } from "zod";

export const SEVERITIES = ["high", "medium", "low"] as const;

export const RuleSchema = z.strictObject({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "use lowercase letters, digits and hyphens, starting with a letter or digit",
    ),
  title: z.string().min(1),
  severity: z.enum(SEVERITIES),
  /**
   * "presence" (the default): the contract should contain a clause that meets the standard.
   * "absence": the standard forbids something, so a contract that does not contain it passes.
   */
  kind: z.enum(["presence", "absence"]).optional(),
  /** When true, a contract with no clause on this topic is reported as missing. */
  required: z.boolean().default(false),
  /** The position we want to see. */
  standard: z.string().min(1),
  /** A position we can live with if the standard is refused. */
  fallback: z.string().min(1).optional(),
  /** What must be flagged and pushed back on. */
  unacceptable: z.string().min(1).optional(),
  /** Free-form advice to the reviewer, including how to word a fix. */
  guidance: z.string().min(1).optional(),
});

export const PlaybookSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    contractTypes: z.array(z.string().min(1)).min(1),
    /** Which side we are on and what we care about, in a sentence or two. */
    perspective: z.string().min(1),
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
    });
  });

export type Rule = z.infer<typeof RuleSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
export type Severity = (typeof SEVERITIES)[number];
