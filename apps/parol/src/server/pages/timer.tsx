import type { TimerView } from "../../services/views.js";
import { urls } from "../urls.js";
import {
  TIMER_ELSEWHERE,
  TIMER_HEADING,
  TIMER_NOTE,
  TIMER_NOT_RUNNING,
  TIMER_OWN_ONLY,
  TIMER_RUNNING_HINT,
  TIMER_RUNNING_SINCE,
  TIMER_START_LABEL,
  TIMER_STOP_LABEL,
  TIMER_TRAINING_NOTE,
  timedSentence,
} from "../views/pilot.js";
import { Chip, Section, Time } from "./components.js";
import { FIELDS } from "./forms.js";
import { csrfField, type Chrome } from "./layout.js";
import { PILOT_ANCHORS, TIMER_INTENTS } from "./pilotfields.js";

/**
 * The timer of a matter, as a section of the matter page (package W2.6b): "Time on this matter".
 * The person starts a timer when they begin work on the NDA and stops it when they pause or finish;
 * the pilot measures page takes the medians of these times, and nothing else is done with them.
 *
 * The panel is the signed-in person's own. The service makes the `TimerView` from that person's own
 * entries (the store filters on the person), so the page cannot show another person's time, and a
 * role that may not time a matter (`allowed` false) is given no panel at all. Nothing here decides
 * a role: the view says whether the person may press the button, and the route and the service
 * check it again.
 *
 * Four states, each a sentence and at most one button: a timer running here (Stop), none running
 * (Start), one running on another matter (no button, no matter named, and the instruction to stop
 * it there first), and the person's closed sessions on this matter, with how many they are. The
 * running state is stated by a chip with a shape and the words, not by colour. The page reads no
 * clock, so it shows when the timer began and not how long it has run; the total counts closed
 * sessions only, and says so.
 *
 * The one button posts to the timer route with `intent` set to its own value, so the form holds
 * only the token and the button. Tab reaches the button in document order and Enter or Space
 * presses it; the page uses no script.
 */
export interface TimerPanelProps {
  chrome: Chrome;
  matterId: string;
  /** From the pilot service. Absent when the service did not fill it: no section. */
  timer: TimerView | undefined;
}

function TimerButton(props: { chrome: Chrome; matterId: string; intent: "start" | "stop" }) {
  return (
    <form method="post" action={urls.matterTimer(props.matterId)} class="stack form-panel">
      {csrfField(props.chrome.csrfToken)}
      <div class="actions">
        <button
          type="submit"
          class="button button-primary"
          name={FIELDS.intent}
          value={TIMER_INTENTS[props.intent]}
        >
          {props.intent === "start" ? TIMER_START_LABEL : TIMER_STOP_LABEL}
        </button>
      </div>
    </form>
  );
}

export function TimerPanel(props: TimerPanelProps) {
  const { timer } = props;
  if (timer === undefined || !timer.allowed) return null;
  // A timer left running on a training matter by an earlier build: the Stop, and nothing else.
  if (timer.training === true && timer.running !== null)
    return (
      <Section id={PILOT_ANCHORS.timer} title={TIMER_HEADING} note={TIMER_TRAINING_NOTE}>
        <p>
          <Chip tone="ok" shape="circle">
            Running
          </Chip>{" "}
          {`${TIMER_RUNNING_SINCE} `}
          <Time value={timer.running.since} />
          {"."}
        </p>
        <TimerButton chrome={props.chrome} matterId={props.matterId} intent="stop" />
      </Section>
    );
  return (
    <Section id={PILOT_ANCHORS.timer} title={TIMER_HEADING} note={TIMER_NOTE}>
      {timer.running !== null ? (
        <>
          <p>
            <Chip tone="ok" shape="circle">
              Running
            </Chip>{" "}
            {`${TIMER_RUNNING_SINCE} `}
            <Time value={timer.running.since} />
            {"."}
          </p>
          <p class="hint">{TIMER_RUNNING_HINT}</p>
          <TimerButton chrome={props.chrome} matterId={props.matterId} intent="stop" />
        </>
      ) : timer.elsewhere ? (
        <p>
          <Chip tone="warn" shape="triangle">
            Running elsewhere
          </Chip>{" "}
          {TIMER_ELSEWHERE}
        </p>
      ) : (
        <>
          <p>{TIMER_NOT_RUNNING}</p>
          <TimerButton chrome={props.chrome} matterId={props.matterId} intent="start" />
        </>
      )}
      <p>{timedSentence(timer.sessions, timer.closedSeconds)}</p>
      <p class="hint">{TIMER_OWN_ONLY}</p>
    </Section>
  );
}
