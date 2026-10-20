CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"paragraphs" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"review_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"edited_replacement" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "findings_review_id_rule_id_pk" PRIMARY KEY("review_id","rule_id"),
	CONSTRAINT "findings_decision_check" CHECK ("findings"."decision" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"yaml" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"playbook_id" text,
	"playbook_name" text NOT NULL,
	"playbook_yaml" text NOT NULL,
	"client" text,
	"status" text NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"error" text,
	"report" jsonb,
	"context" jsonb,
	"model_provider" text,
	"model_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reviews_status_check" CHECK ("reviews"."status" in ('queued', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_document_id_idx" ON "reviews" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");