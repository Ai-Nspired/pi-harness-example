import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  CodeIcon,
  FilePlusIcon,
  GearIcon,
  GitBranchIcon,
  MicrophoneIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { ToolInfo, TranscriptMessage, TranscriptPart } from "./protocol";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const SESSION_KEY = "pi-harness-session";
/**
 * The preset this Worker is actually configured to run. It asks the server
 * rather than naming a model here, so the header cannot claim a route the
 * session is not on.
 */
function RouteBadge() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/route")
      .then(async (response) => {
        if (!response.ok) return undefined;
        return (await response.json()) as { model?: string };
      })
      .then((route) => {
        if (!live || !route?.model) return;
        setLabel(route.model.split("/").at(-1) ?? route.model);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!label) return null;
  return (
    <Badge variant="secondary" className="hidden sm:inline-flex">
      {label}
    </Badge>
  );
}

const SUGGESTIONS = [
  {
    icon: <FilePlusIcon size={15} />,
    label: "Write a file",
    value:
      "Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back."
  },
  {
    icon: <CodeIcon size={15} />,
    label: "Run JavaScript",
    value:
      "Use exec to run JavaScript that lists /workspace and returns the size of each file."
  },
  {
    icon: <GitBranchIcon size={15} />,
    label: "Clone a repo",
    value:
      "Clone https://github.com/octocat/Hello-World into /workspace/hello, then show its git log."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

/**
 * A JSON body, or an error that explains what came back instead. A route that
 * is not deployed answers with an HTML page, and "Unexpected token '<'" tells
 * nobody which one.
 */
async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T & { error?: string };
  } catch {
    const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(
      `${response.status} ${response.statusText}${
        text ? `: ${text.slice(0, 140)}` : ""
      }`
    );
  }
}

/**
 * The preset switch. The server names the presets it will accept, and the
 * active one comes from the session's stored model, so this shows the preset
 * the next reply will actually run on. Pressing the active one clears it: no
 * preset is selected, and the plain model answers.
 */
function PresetToggle({
  presets,
  current,
  onPick
}: {
  presets: readonly string[];
  current: string | null;
  onPick: (slug: string) => void;
}) {
  if (presets.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-kumo-line bg-kumo-base">
      <div
        role="group"
        aria-label="Preset"
        className="mx-auto flex max-w-3xl items-center gap-1.5 overflow-x-auto px-5 py-2"
      >
        {presets.map((slug) => {
          const active = slug === current;
          return (
            <button
              key={slug}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(active ? "" : slug)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                active
                  ? "border-transparent bg-kumo-brand text-white"
                  : "border-kumo-line bg-kumo-base text-kumo-subtle hover:text-kumo-default"
              }`}
            >
              {slug}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.name}
        </span>
        <Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Arguments
        </p>
        <JsonBlock value={part.arguments} />
      </div>
    </details>
  );
}

function ToolResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  const images = part.content.filter((content) => content.type === "image");
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {part.error ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {text ? <span className="ml-2 text-kumo-subtle">{text}</span> : null}
        </span>
        <Badge variant={part.error ? "destructive" : "secondary"}>
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        {text ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={text} />
          </div>
        ) : null}
        {images.map((image, index) =>
          image.type === "image" ? (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`${part.name} output`}
              className="max-w-full rounded-lg"
            />
          ) : null
        )}
        {part.details !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Details
            </p>
            <JsonBlock value={part.details} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantPart({
  part,
  running
}: {
  part: TranscriptPart;
  running: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code }}
          controls={false}
        >
          {part.text}
        </Streamdown>
      );
    case "thinking":
      return (
        <details className="rounded-xl border border-kumo-line px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
            Thinking
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );
    case "tool-call":
      return <ToolCallCard part={part} running={running} />;
    case "tool-result":
      return <ToolResultCard part={part} />;
    case "image":
      return (
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt=""
          className="max-w-full rounded-lg"
        />
      );
  }
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <BrainIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <AssistantPart
            key={`${message.id}-${index}`}
            part={part}
            running={
              streaming &&
              part.type === "tool-call" &&
              runningTools.includes(part.name)
            }
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className="ml-11 space-y-2">
      {message.parts.map((part, index) =>
        part.type === "tool-result" ? (
          <ToolResultCard key={`${message.id}-${index}`} part={part} />
        ) : null
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          streaming={streaming}
          runningTools={runningTools}
        />
      );
    case "tool":
      return <ToolMessage message={message} />;
    case "notice":
      return message.parts.length === 0 ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          {message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
        </p>
      );
  }
}

function Sidebar({
  tools,
  activeTools,
  onClose
}: {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  onClose: () => void;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Tools"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <Text size="sm" bold>
          Tools
        </Text>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close tools"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {tools.map((tool) => (
          <Surface
            key={tool.name}
            className="rounded-lg p-3 ring ring-kumo-line"
          >
            <div className="flex items-center gap-2">
              {activeTools.includes(tool.name) ? (
                <GearIcon size={14} className="animate-spin text-kumo-accent" />
              ) : (
                <WrenchIcon size={14} className="text-kumo-inactive" />
              )}
              <code className="text-xs font-semibold">{tool.name}</code>
            </div>
            <p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
          </Surface>
        ))}
      </div>
    </aside>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const [toolsOpen, setToolsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  // Dictation and uploads both end as text in the composer, so the model gets
  // an ordinary message and nothing new is needed on the wire.
  const [intake, setIntake] = useState<
    null | "recording" | "transcribing" | "reading"
  >(null);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorded = useRef<Blob[]>([]);
  const filePicker = useRef<HTMLInputElement>(null);

  const appendToPrompt = (text: string) =>
    setPrompt((current) => (current.trim() ? `${current}\n\n${text}` : text));

  const dictate = async () => {
    if (intake === "recording") {
      recorder.current?.stop();
      return;
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) {
      setIntakeError("This browser cannot record audio.");
      return;
    }
    setIntakeError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      recorded.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) recorded.current.push(event.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(recorded.current, {
          type: media.mimeType || "audio/webm"
        });
        if (blob.size === 0) {
          setIntake(null);
          setIntakeError("Nothing was recorded. Try again and speak after the tap.");
          return;
        }
        setIntake("transcribing");
        void fetch("/api/transcribe", {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob
        })
          .then(async (response) => {
            const payload = await readJson<{ text?: string }>(response);
            if (!response.ok) {
              throw new Error(payload.error ?? `HTTP ${response.status}`);
            }
            if (!payload.text) {
              throw new Error("No speech was heard in that recording.");
            }
            appendToPrompt(payload.text);
          })
          .catch((error: unknown) =>
            setIntakeError(error instanceof Error ? error.message : String(error))
          )
          .finally(() => setIntake(null));
      };
      recorder.current = media;
      media.start();
      setIntake("recording");
    } catch {
      setIntake(null);
      setIntakeError(
        "The microphone was refused. Allow it in the browser settings."
      );
    }
  };

  const attach = async (file: File) => {
    setIntakeError(null);
    setIntake("reading");
    try {
      const response = await fetch(
        `/api/extract?name=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        }
      );
      const payload = await readJson<{
        name?: string;
        text?: string;
        truncated?: boolean;
      }>(response);
      if (!response.ok || !payload.text) {
        throw new Error(payload.error ?? `Could not read ${file.name}`);
      }
      appendToPrompt(
        `${payload.name ?? file.name}${
          payload.truncated ? " (first part)" : ""
        }:\n${payload.text}`
      );
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIntake(null);
    }
  };
  const {
    status,
    messages,
    live,
    running,
    tools: running_,
    catalog,
    queued,
    retry,
    error,
    model,
    presets,
    setPreset,
    submit: submitPrompt,
    abort
  } = usePiSession(session);
  const runningTools = running_.map((tool) => tool.name);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
  };

  const newSession = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  const empty = messages.length === 0 && !live && !running;

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        toolsOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                <BrainIcon size={20} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">Pi harness</h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Session <code>{session.slice(0, 8)}</code>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <RouteBadge />
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
                icon={<WrenchIcon size={16} />}
              />
              <Button
                variant="ghost"
                shape="square"
                aria-label="New session"
                onClick={newSession}
                icon={<PlusIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <PresetToggle
          presets={presets}
          current={model?.modelId.replace(/^@preset\//, "") ?? null}
          onPick={setPreset}
        />

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="Ask Pi something that needs a tool"
                  description="Tool calls and results stream in as they happen."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      icon={suggestion.icon}
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {live ? (
              <Message message={live} streaming runningTools={runningTools} />
            ) : null}

            {running && !live ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    {retry
                      ? `Retrying: ${retry.error}`
                      : runningTools.length > 0
                        ? `Running ${runningTools.join(", ")}`
                        : "Waiting for the model"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {running_.map((tool) =>
              tool.output ? (
                <pre
                  key={tool.callId}
                  className="ml-11 max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs"
                >
                  {tool.output}
                </pre>
              ) : null
            )}

            {queued > 0 ? (
              <p className="ml-11 text-xs text-kumo-subtle">
                {queued} queued behind this run
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl px-5 pt-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <div className="mb-0.5 flex gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  aria-label={
                    intake === "recording" ? "Stop dictating" : "Dictate a message"
                  }
                  aria-pressed={intake === "recording"}
                  disabled={
                    !connected || intake === "transcribing" || intake === "reading"
                  }
                  onClick={() => void dictate()}
                  icon={
                    <MicrophoneIcon
                      size={18}
                      weight={intake === "recording" ? "fill" : "regular"}
                      className={
                        intake === "recording" ? "text-kumo-danger" : undefined
                      }
                    />
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  aria-label="Attach a file"
                  disabled={!connected || intake !== null}
                  onClick={() => filePicker.current?.click()}
                  icon={<PaperclipIcon size={18} />}
                />
                <input
                  ref={filePicker}
                  type="file"
                  className="hidden"
                  accept=".pdf,.docx,.txt,.md,.csv,.json,application/pdf,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void attach(file);
                  }}
                />
              </div>
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  running
                    ? "Queue a follow-up, or steer the running turn"
                    : "Ask Pi to use a tool"
                }
                aria-label="Message Pi"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Steer"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          {intake && intake !== "recording" ? (
            <p className="mx-auto max-w-3xl px-5 pt-2 text-xs text-kumo-subtle">
              {intake === "transcribing" ? "Transcribing…" : "Reading the file…"}
            </p>
          ) : null}
          {intakeError ? (
            <p
              role="alert"
              className="mx-auto max-w-3xl px-5 pt-2 text-xs text-kumo-danger"
            >
              {intakeError}
            </p>
          ) : null}
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-[10px] text-kumo-inactive sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>

      {toolsOpen ? (
        <Sidebar
          tools={catalog}
          activeTools={runningTools}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
