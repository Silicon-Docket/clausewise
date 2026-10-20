import type {
  Decision,
  Finding,
  PatchFindingRequest,
  ReviewDetail,
  Severity,
} from "@clausewise/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, errorMessage, isAbortError } from "../api/client.js";
import { applyBulk, editRequestFor, resetRequestFor } from "../lib/findings.js";
import { DECISION_LABEL, plural } from "../lib/format.js";
import { shareUnchanged } from "../lib/share.js";
import { useServices } from "../services.js";
import { useAnnounce } from "./useAnnounce.js";
import { usePolling } from "./usePolling.js";

export type ReviewLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: ReviewDetail };

/** How often a queued or running review is read again. */
export const POLL_INTERVAL_MS = 1000;
/** Progress is read out at most this often, so that a screen reader is not talked over. */
const PROGRESS_ANNOUNCE_MS = 5000;

const isActive = (status: ReviewDetail["status"]): boolean =>
  status === "queued" || status === "running";

/**
 * Everything the review screen does with one review: reads it, follows it while it runs, and
 * changes the lawyer's decisions. A decision change is shown at once and undone if the server
 * refuses it, with the reason in `rowErrors`. While one change is on its way the same finding can
 * not be changed again, and a bulk change holds every finding, so a rollback can never overwrite a
 * newer answer.
 */
export function useReview(reviewId: string) {
  const { api } = useServices();
  const announce = useAnnounce();

  const [load, setLoad] = useState<ReviewLoad>({ status: "loading" });
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // The newest detail, for the actions: they run after awaits, when a closure would be stale.
  const detailRef = useRef<ReviewDetail | null>(null);
  // A read that learned nothing new keeps the objects the screen already holds, and with them the
  // screen as it is: React sees the same state and draws nothing.
  const setDetail = useCallback((detail: ReviewDetail) => {
    const shared = shareUnchanged(detailRef.current, detail);
    detailRef.current = shared;
    setLoad((current) =>
      current.status === "ready" && current.detail === shared
        ? current
        : { status: "ready", detail: shared },
    );
  }, []);
  const updateFindings = useCallback((change: (findings: Finding[]) => Finding[]) => {
    const current = detailRef.current;
    if (current === null) return;
    const next = { ...current, findings: change(current.findings) };
    detailRef.current = next;
    setLoad({ status: "ready", detail: next });
  }, []);
  const replaceFinding = useCallback(
    (finding: Finding) => {
      updateFindings((findings) =>
        findings.map((existing) => (existing.ruleId === finding.ruleId ? finding : existing)),
      );
    },
    [updateFindings],
  );

  const mounted = useRef(true);
  const lastStatus = useRef<ReviewDetail["status"] | null>(null);
  // The last progress figure that was read out, and when. Null until a run is first seen.
  const spokenProgress = useRef<{ done: number; at: number } | null>(null);
  const pollProblemSpoken = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // First read.
  useEffect(() => {
    const controller = new AbortController();
    detailRef.current = null;
    lastStatus.current = null;
    setLoad({ status: "loading" });
    setPollProblem(null);
    api
      .getReview(reviewId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setDetail(detail);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setLoad({ status: "error", message: errorMessage(error) });
      });
    return () => {
      controller.abort();
    };
  }, [api, reviewId, setDetail]);

  // Following a review that is still going.
  const status = load.status === "ready" ? load.detail.status : null;
  usePolling({
    enabled: status !== null && isActive(status),
    intervalMs: POLL_INTERVAL_MS,
    tick: async (signal) => {
      try {
        const detail = await api.getReview(reviewId, signal);
        if (signal.aborted) return;
        setDetail(detail);
        setPollProblem(null);
        pollProblemSpoken.current = false;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        if (error instanceof ApiClientError && error.status === 404) {
          setLoad({ status: "error", message: error.message });
          return;
        }
        const problem =
          error instanceof ApiClientError && error.status === 0
            ? "The server cannot be reached. This page keeps trying."
            : `The latest progress could not be read. ${errorMessage(error)} This page keeps trying.`;
        setPollProblem(problem);
        // Said once when it starts, not at every failed attempt after it.
        if (!pollProblemSpoken.current) {
          pollProblemSpoken.current = true;
          announce(problem);
        }
      }
    },
  });

  // Telling a screen reader that something happened. Only changes seen on this screen are spoken:
  // opening a finished review does not announce that it finished.
  useEffect(() => {
    if (load.status !== "ready") return;
    const { detail } = load;
    const previous = lastStatus.current;
    lastStatus.current = detail.status;
    if (previous === null || previous === detail.status) return;
    if (detail.status === "running") announce("The review has started.");
    else if (detail.status === "done") {
      announce(`The review is finished. ${plural(detail.findings.length, "finding")} to look at.`);
    } else if (detail.status === "failed") announce("The review failed.");
    else if (detail.status === "cancelled") announce("The review was cancelled.");
  }, [load, announce]);

  // Progress is read out when the number of rules checked has changed, and not oftener than every
  // few seconds. A poll that finds the same number says nothing, and a change that comes too soon
  // is held back and spoken, as the newest figure, when the wait is over.
  const running = load.status === "ready" && load.detail.status === "running";
  const progressDone = load.status === "ready" ? load.detail.progress.done : 0;
  const progressTotal = load.status === "ready" ? load.detail.progress.total : 0;
  useEffect(() => {
    if (!running) {
      spokenProgress.current = null;
      return undefined;
    }
    const last = spokenProgress.current;
    if (last === null) {
      // First sight of the run: the figure is on the screen already.
      spokenProgress.current = { done: progressDone, at: Date.now() };
      return undefined;
    }
    if (progressDone === last.done) return undefined;
    const speak = (): void => {
      announce(`${progressDone} of ${progressTotal} rules checked.`);
      spokenProgress.current = { done: progressDone, at: Date.now() };
    };
    const wait = last.at + PROGRESS_ANNOUNCE_MS - Date.now();
    if (wait <= 0) {
      speak();
      return undefined;
    }
    const timer = setTimeout(speak, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [running, progressDone, progressTotal, announce]);

  const setRowBusyFor = useCallback((ruleId: string, busy: boolean) => {
    setRowBusy((current) => {
      const next = new Set(current);
      if (busy) next.add(ruleId);
      else next.delete(ruleId);
      return next;
    });
  }, []);
  const setRowErrorFor = useCallback((ruleId: string, message: string | null) => {
    setRowErrors((current) => {
      if (message === null) {
        if (!(ruleId in current)) return current;
        const rest = { ...current };
        delete rest[ruleId];
        return rest;
      }
      return { ...current, [ruleId]: message };
    });
  }, []);

  /** Shows `optimistic` at once, sends `body`, and restores the finding if the server refuses. */
  const change = useCallback(
    async (
      ruleId: string,
      optimistic: (finding: Finding) => Finding,
      body: PatchFindingRequest,
      spoken: (saved: Finding, accepted: number) => string,
    ): Promise<boolean> => {
      const before = detailRef.current?.findings.find((finding) => finding.ruleId === ruleId);
      if (before === undefined) return false;
      setRowBusyFor(ruleId, true);
      setRowErrorFor(ruleId, null);
      replaceFinding(optimistic(before));
      try {
        const saved = await api.patchFinding(reviewId, ruleId, body);
        replaceFinding(saved);
        const accepted =
          detailRef.current?.findings.filter((finding) => finding.decision === "accepted").length ??
          0;
        announce(spoken(saved, accepted));
        return true;
      } catch (error) {
        replaceFinding(before);
        // The card shows this in an alert, which is read out by itself.
        const message = `That change was not saved, and the finding is back as it was. ${errorMessage(error)}`;
        setRowErrorFor(ruleId, message);
        return false;
      } finally {
        if (mounted.current) setRowBusyFor(ruleId, false);
      }
    },
    [api, announce, reviewId, replaceFinding, setRowBusyFor, setRowErrorFor],
  );

  const decide = useCallback(
    (ruleId: string, decision: Decision): Promise<boolean> =>
      change(
        ruleId,
        (finding) => ({ ...finding, decision }),
        { decision },
        (saved, accepted) =>
          `${saved.title}: ${DECISION_LABEL[saved.decision].toLowerCase()}. ${accepted} accepted in all.`,
      ),
    [change],
  );

  const saveEdit = useCallback(
    (ruleId: string, text: string, accept: boolean): Promise<boolean> => {
      const finding = detailRef.current?.findings.find((item) => item.ruleId === ruleId);
      if (finding === undefined) return Promise.resolve(false);
      const body = editRequestFor(finding, text, accept);
      // Nothing differs from what is stored: the editor can close without asking the server.
      if (body === null) return Promise.resolve(true);
      return change(
        ruleId,
        (current) => ({
          ...current,
          ...(body.decision === undefined ? {} : { decision: body.decision }),
          ...(body.editedReplacement === undefined
            ? {}
            : { editedReplacement: body.editedReplacement }),
        }),
        body,
        (saved) => `${saved.title}: your wording was saved.`,
      );
    },
    [change],
  );

  const reset = useCallback(
    (ruleId: string): Promise<boolean> => {
      const finding = detailRef.current?.findings.find((item) => item.ruleId === ruleId);
      if (finding === undefined) return Promise.resolve(false);
      return change(
        ruleId,
        (current) => ({ ...current, decision: "pending", editedReplacement: null }),
        resetRequestFor(finding),
        (saved) => `${saved.title}: back to not decided.`,
      );
    },
    [change],
  );

  const bulk = useCallback(
    async (decision: Decision, severities?: Severity[]): Promise<void> => {
      const current = detailRef.current;
      if (current === null) return;
      const before = current.findings;
      setBulkBusy(true);
      setBulkError(null);
      updateFindings((findings) => applyBulk(findings, decision, severities));
      try {
        const result = await api.bulkDecision(reviewId, {
          decision,
          ...(severities === undefined ? {} : { severities }),
        });
        announce(`${plural(result.updated, "finding")} ${DECISION_LABEL[decision].toLowerCase()}.`);
        // The server decides what a bulk change touched, so the screen takes its word for it.
        try {
          setDetail(await api.getReview(reviewId));
        } catch {
          // The screen keeps what it showed; the next read corrects it.
        }
      } catch (error) {
        updateFindings(() => before);
        setBulkError(
          `That change was not saved, and the findings are back as they were. ${errorMessage(error)}`,
        );
      } finally {
        if (mounted.current) setBulkBusy(false);
      }
    },
    [api, announce, reviewId, setDetail, updateFindings],
  );

  const cancel = useCallback(async (): Promise<void> => {
    setCancelBusy(true);
    setCancelError(null);
    try {
      const summary = await api.cancelReview(reviewId);
      const current = detailRef.current;
      if (current !== null) setDetail({ ...current, ...summary });
    } catch (error) {
      setCancelError(errorMessage(error));
      // A 409 means it ended on its own just now; show how it ended.
      if (error instanceof ApiClientError && error.status === 409) {
        try {
          setDetail(await api.getReview(reviewId));
        } catch {
          // The polling picks it up.
        }
      }
    } finally {
      if (mounted.current) setCancelBusy(false);
    }
  }, [api, reviewId, setDetail]);

  return {
    load,
    pollProblem,
    rowBusy,
    rowErrors,
    bulkBusy,
    bulkError,
    cancelBusy,
    cancelError,
    decide,
    saveEdit,
    reset,
    bulk,
    cancel,
  };
}
