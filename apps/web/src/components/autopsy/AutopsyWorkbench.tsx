"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createClient, type SessionInput, type Unsubscribe } from "@/lib/api-client";
import { resultAnnouncement } from "@/lib/a11y/summary";
import {
  allAnomalies,
  initialState,
  sessionReducer,
  toSceneGraph,
} from "@/lib/session-reducer";
import type { CreateSessionResponse, SessionEvent } from "@/types/autopsy";
import { AutopsyCanvasDynamic } from "./AutopsyCanvas";
import { AutopsySummary } from "./AutopsySummary";
import { DropzoneModal, PRESETS } from "./DropzoneModal";
import { EntityList } from "./EntityList";
import { GeneratedCodeView } from "./GeneratedCodeView";
import { LiveAnnouncer, useAnnounce } from "./LiveAnnouncer";
import { NodeInspector } from "./NodeInspector";
import { ProgressRail } from "./ProgressRail";
import { SearchPanel } from "./SearchPanel";
import { VisionXRayOverlay } from "./VisionXRayOverlay";

const SUMMARY_ID = "autopsy-summary";

function sourceNameOf(input: SessionInput): string {
  if (input.kind === "preset") return PRESETS.find((p) => p.id === input.preset)?.label ?? input.preset;
  if (input.kind === "file") return input.copybook ? `${input.file.name} + ${input.copybook.name}` : input.file.name;
  return "Pasted text";
}

function Workbench() {
  const announce = useAnnounce();
  const client = useMemo(() => createClient(), []);
  const [state, dispatch] = useReducer(sessionReducer, undefined, initialState);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dropzoneOpen, setDropzoneOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const unsubscribeRef = useRef<Unsubscribe | null>(null);
  const lastEventIdRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const canvasRegionRef = useRef<HTMLDivElement>(null);

  const connect = useCallback(
    (id: string) => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = client.subscribe(
        id,
        {
          onEvent: (e) => {
            if (e.id <= lastEventIdRef.current) return;
            lastEventIdRef.current = e.id;
            dispatch({ type: "connection_ok" });
            setEvents((prev) => [...prev, e]);
            dispatch(e);
          },
          onReconnecting: (attempt) => dispatch({ type: "connection_reconnecting", attempt }),
          onConnectionLost: () => dispatch({ type: "connection_lost" }),
        },
        lastEventIdRef.current,
      );
    },
    [client],
  );

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  };

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      releaseObjectUrl();
    },
    [],
  );

  const onSession = useCallback(
    (response: CreateSessionResponse, input: SessionInput) => {
      releaseObjectUrl();
      lastEventIdRef.current = 0;
      setEvents([]);
      setInspectorOpen(false);
      setSessionId(response.session_id);
      setSourceName(sourceNameOf(input));
      dispatch({ type: "session_started", inputKind: response.input_kind, cached: response.cached });
      if (response.input_kind === "image") {
        if (input.kind === "preset") setImageUrl(client.presetImageUrl(input.preset));
        else if (input.kind === "file") {
          objectUrlRef.current = URL.createObjectURL(input.file);
          setImageUrl(objectUrlRef.current);
        } else setImageUrl(null);
      } else setImageUrl(null);
      connect(response.session_id);
    },
    [client, connect],
  );

  const entities = state.schema?.entities ?? [];
  const anomalies = useMemo(() => allAnomalies(state), [state]);
  const graph = useMemo(() => toSceneGraph(state.schema, state.ml, state.rot), [state.schema, state.ml, state.rot]);
  const selected = entities.find((e) => e.name === state.selectedEntityId) ?? null;
  const highlighted = useMemo(() => [...new Set(state.searchHits.map((h) => h.entity))], [state.searchHits]);

  useEffect(() => {
    if (!state.schema) return;
    announce(resultAnnouncement(state.schema.entities.length, anomalies.length));
  }, [state.schema, anomalies.length, announce]);

  useEffect(() => {
    if (state.connection.status === "lost") announce("Connection lost. Progress is kept; you can retry.");
  }, [state.connection.status, announce]);

  const openEntity = useCallback((name: string, el: HTMLElement | null) => {
    dispatch({ type: "select_entity", entityId: name });
    setOpener(el);
    setInspectorOpen(true);
  }, []);

  const showXRay = state.inputKind === "image" && state.vision !== null && imageUrl !== null;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-col justify-between gap-3 border-b border-border pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-tight text-emerald-400">
            NECROLEGACY {"//"} DIGITAL AUTOPSY WORKBENCH
          </h1>
          <p className="text-xs text-muted-foreground">
            OpenCV vision extraction · scikit-learn Isolation Forest and PCA · LangGraph multi-agent forensics
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sourceName && (
            <span className="rounded-full border border-emerald-800 bg-emerald-950/50 px-3 py-1 font-mono text-xs text-emerald-300">
              Active dump: {sourceName}
            </span>
          )}
          <button
          type="button"
          onClick={() => setDropzoneOpen(true)}
          className="rounded-md border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          New autopsy
          </button>
        </div>
      </header>

      <DropzoneModal client={client} onSession={onSession} open={dropzoneOpen} onOpenChange={setDropzoneOpen} />

      {state.phase === "idle" ? (
        <p className="text-muted-foreground">Upload a legacy dump or choose a preset to begin the autopsy.</p>
      ) : (
        <ProgressRail events={events} />
      )}

      {state.servedFromCache && <p role="note">Served from cache: this result was computed earlier.</p>}

      {state.connection.status === "reconnecting" && (
        <p role="status">Reconnecting (attempt {state.connection.attempt})…</p>
      )}
      {state.connection.status === "lost" && (
        <div role="alert" className="flex items-center gap-3">
          <span>Connection lost. Progress so far is kept.</span>
          <button
            type="button"
            className="rounded-md border px-3 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => {
              if (!sessionId) return;
              dispatch({ type: "connection_ok" });
              connect(sessionId);
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {state.phase === "failed" && <p role="alert">The autopsy failed. Partial results are shown where available.</p>}

      <div className={showXRay ? "grid grid-cols-1 gap-6 lg:grid-cols-12" : "flex flex-col"}>
      {showXRay && state.vision && imageUrl && (
        <section aria-label="Uploaded image" className="lg:col-span-5">
          <VisionXRayOverlay
            imageUrl={imageUrl}
            imageWidth={state.vision.image_width}
            imageHeight={state.vision.image_height}
            cells={state.vision.cells}
            defects={state.vision.defects}
            onAnnounce={announce}
          />
        </section>
      )}
      {state.inputKind === "image" && !showXRay && imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="Uploaded document" className="max-h-64 w-auto object-contain" />
      )}

      <div ref={canvasRegionRef} tabIndex={-1} className={showXRay ? "min-h-[24rem] lg:col-span-7" : "min-h-[24rem]"}>
        <AutopsyCanvasDynamic
          entities={entities}
          anomalies={anomalies}
          graph={graph}
          highlightedIds={highlighted}
          summaryId={SUMMARY_ID}
          onSelect={(id) => openEntity(id, null)}
          onOpenEntity={openEntity}
        />
      </div>
      </div>

      <AutopsySummary id={SUMMARY_ID} entities={entities} anomalies={anomalies} />
      <EntityList entities={entities} anomalies={anomalies} onOpen={openEntity} />

      {sessionId && state.schema && (
        <SearchPanel client={client} sessionId={sessionId} onHits={(hits) => dispatch({ type: "search_results", hits })} />
      )}

      <GeneratedCodeView resurrection={state.resurrection} />

      <NodeInspector
        entity={selected}
        anomalies={anomalies}
        open={inspectorOpen && selected !== null}
        onOpenChange={setInspectorOpen}
        opener={opener}
        returnFocusRef={canvasRegionRef}
      />
    </main>
  );
}

export function AutopsyWorkbench() {
  return (
    <LiveAnnouncer>
      <Workbench />
    </LiveAnnouncer>
  );
}

export default AutopsyWorkbench;
