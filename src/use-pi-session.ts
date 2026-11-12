import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import { PiCommandOutbox } from "./outbox";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
  /** Preset slugs the server will accept a switch to, from its hello. */
  readonly presets: readonly string[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  presets: []
};

/**
 * One pi session over the harness's WebSocket protocol, connected with
 * `useAgent`. The server sends pi's own agent events; this folds them with
 * the same `reduceEvents` the server tests use. A reconnect gets a fresh
 * snapshot, and the client sends again every submit whose answer the
 * socket never delivered; the harness deduplicates them by operation id, so
 * each runs once.
 */
export function usePiSession(object: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  // Unanswered submits, sent again each time the socket opens.
  const [outbox] = useState(() => new PiCommandOutbox());
  // Another object starts from a clean slate.
  const [stateObject, setStateObject] = useState(object);
  if (stateObject !== object) {
    setStateObject(object);
    setState(INITIAL_STATE);
  }

  const agent = useAgent({
    agent: "pi-agent",
    name: object,
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      outbox.receive(message);
      switch (message.type) {
        case "hello":
          setState((current) => ({
            ...current,
            catalog: message.tools,
            presets: message.presets
          }));
          return;
        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events)
          }));
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    // Submits belong to the last object's session: never send them here.
    outbox.clear();
  }, [object, outbox]);

  useEffect(() => {
    if (state.status !== "open") return;
    outbox.sendPending((data) => agent.send(data));
  }, [state.status, agent, outbox]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run.
   * Kept in the outbox until answered, and sent again if the socket drops
   * first.
   */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send(outbox.submit(text, whenBusy)),
    [send, outbox]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const reset = useCallback(
    () => send({ type: "reset", id: crypto.randomUUID() }),
    [send]
  );

  /**
   * Switch the session to a configured preset. The stored choice comes back as
   * pi's `agent_changed` event, so `model` in this state is the truth, not the
   * value that was asked for.
   */
  const setPreset = useCallback(
    (preset: string) =>
      send({ type: "setModel", id: crypto.randomUUID(), preset }),
    [send]
  );

  return { ...state, submit, abort, reset, setPreset };
}
