import type { Decision, ReviewStatus } from "@clausewise/api";
import type { ReviewReport } from "@clausewise/review";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { StoredContext } from "../context.js";

// Ids are made by the application (see IdSource), not by the database, so that a test can know
// them and so that the same code runs on PGlite and on Postgres.
const stamp = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  /** The name to show, already cleaned. The file on disk is named by `storageKey` alone. */
  fileName: text("file_name").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  paragraphs: integer("paragraphs").notNull(),
  createdAt: stamp("created_at").notNull(),
});

/** Custom playbooks only. Built-in ones are read from the playbooks folder. */
export const playbooks = pgTable("playbooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  yaml: text("yaml").notNull(),
  createdAt: stamp("created_at").notNull(),
  updatedAt: stamp("updated_at").notNull(),
});

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** No foreign key: a review keeps its snapshot after the playbook is edited or deleted. */
    playbookId: text("playbook_id"),
    playbookName: text("playbook_name").notNull(),
    playbookYaml: text("playbook_yaml").notNull(),
    client: text("client"),
    status: text("status").$type<ReviewStatus>().notNull(),
    progressDone: integer("progress_done").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    error: text("error"),
    report: jsonb("report").$type<ReviewReport>(),
    context: jsonb("context").$type<StoredContext>(),
    modelProvider: text("model_provider"),
    modelName: text("model_name"),
    createdAt: stamp("created_at").notNull(),
    startedAt: stamp("started_at"),
    finishedAt: stamp("finished_at"),
  },
  (table) => [
    index("reviews_document_id_idx").on(table.documentId),
    index("reviews_status_idx").on(table.status),
    check(
      "reviews_status_check",
      sql`${table.status} in ('queued', 'running', 'done', 'failed', 'cancelled')`,
    ),
  ],
);

export const findings = pgTable(
  "findings",
  {
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    decision: text("decision").$type<Decision>().notNull().default("pending"),
    editedReplacement: text("edited_replacement"),
    updatedAt: stamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reviewId, table.ruleId] }),
    check("findings_decision_check", sql`${table.decision} in ('pending', 'accepted', 'rejected')`),
  ],
);
