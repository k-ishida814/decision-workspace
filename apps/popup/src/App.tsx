/** The Popup screen (T-603): one question at a time, state in @dw/core's popupReducer. */
import {
  currentQuestion,
  initialPopupState,
  type PopupUiState,
  popupKey,
  popupReducer,
} from "@dw/core";
import { PopupShow } from "@dw/protocol";
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { Bridge } from "./bridge";

export function App({ bridge }: { bridge: Bridge }) {
  const [state, dispatch] = useReducer(popupReducer, initialPopupState);
  const root = useRef<HTMLDivElement>(null);
  const textField = useRef<HTMLInputElement>(null);
  const shown = useRef(false);

  useEffect(() => {
    bridge.onMessage((line) => {
      const parsed = PopupShow.safeParse(JSON.parse(line));
      if (parsed.success) dispatch({ type: "show", show: parsed.data });
    });
  }, [bridge]);

  // Size the window to the content; the first render also shows it.
  useLayoutEffect(() => {
    if (!state.show || !root.current) return;
    const height = Math.ceil(root.current.getBoundingClientRect().height) + 28; // title bar
    if (shown.current) bridge.fit(height);
    else {
      shown.current = true;
      // requestAnimationFrame does not run while the window is hidden (S-06).
      setTimeout(() => bridge.shown(height), 0);
    }
  });

  useEffect(() => {
    if (state.done) bridge.reply(JSON.stringify(state.done));
  }, [state.done, bridge]);

  useEffect(() => {
    if (state.editing) textField.current?.focus();
  }, [state.editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.editing) {
        if (e.key === "Escape") dispatch({ type: "edit", on: false });
        // Enter while the IME is composing only commits the conversion.
        else if (e.key === "Enter" && !e.isComposing) dispatch({ type: "confirm" });
        return;
      }
      const action = popupKey(e.key);
      if (!action) return;
      e.preventDefault();
      dispatch(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.editing]);

  const q = currentQuestion(state);
  if (!state.show || !q) return <div ref={root} className="popup" />;
  const total = state.show.questions.length;
  return (
    <div ref={root} className="popup">
      <Origin state={state} />
      <h1>
        {q.title ? <span className="title">{q.title}</span> : null}
        {q.question}
        {total > 1 ? <span className="count">{`${state.index + 1}/${total}`}</span> : null}
      </h1>
      {q.kind !== "text" ? (
        <div className="options">
          {q.options.map((o, i) => {
            const active = i === state.cursor;
            const picked = state.picked.includes(o.id);
            return (
              <button
                type="button"
                key={o.id}
                className={`option${active ? " active" : ""}${picked ? " picked" : ""}`}
                onClick={() => dispatch({ type: "click", option: i })}
              >
                <span className="label">
                  {q.kind === "multi" ? <span className="box">{picked ? "☑" : "☐"}</span> : null}
                  <span className="key">{i + 1}</span>
                  {o.label}
                  {o.recommended ? <span className="badge">recommended</span> : null}
                </span>
                {o.description ? <span className="desc">{o.description}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {state.editing || q.kind === "text" ? (
        <input
          ref={textField}
          className="text"
          placeholder="Your answer (Enter to send, Esc to go back)"
          value={state.text}
          onChange={(e) => dispatch({ type: "text", value: e.target.value })}
          onFocus={() => dispatch({ type: "edit", on: true })}
        />
      ) : null}
      {state.notice ? <div className="notice">{state.notice}</div> : null}
      <div className="bar">
        <button type="button" className="primary" onClick={() => dispatch({ type: "confirm" })}>
          {q.kind === "multi" ? "Confirm" : "Answer"} <kbd>Enter</kbd>
        </button>
        {q.kind !== "text" && q.allowOther ? (
          <button type="button" onClick={() => dispatch({ type: "edit", on: true })}>
            Own words <kbd>o</kbd>
          </button>
        ) : null}
        <button type="button" onClick={() => dispatch({ type: "skip" })}>
          Skip <kbd>s</kbd>
        </button>
        <span className="spacer" />
        {state.show.canWorkspace ? (
          <button type="button" onClick={() => dispatch({ type: "toWorkspace" })}>
            Workspace <kbd>w</kbd>
          </button>
        ) : null}
        <button type="button" onClick={() => dispatch({ type: "fallback" })}>
          In Claude Code <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

function Origin({ state }: { state: PopupUiState }) {
  const show = state.show;
  if (!show) return null;
  const at = new Date(show.origin.at);
  const time = Number.isNaN(at.getTime())
    ? show.origin.at
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="origin">
      <span>{show.origin.project}</span>
      {show.origin.session ? <span>session {show.origin.session}</span> : null}
      <span>{time}</span>
      {show.more > 0 ? <span className="more">{show.more} more waiting</span> : null}
    </div>
  );
}
