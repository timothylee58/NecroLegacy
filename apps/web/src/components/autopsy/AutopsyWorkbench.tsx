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
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutopsyCanvasDynamic } from "./AutopsyCanvas";
import { CoronersNotice } from "./CoronersNotice";
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

  const idle = state.phase === "idle";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[96rem] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 md:px-8">
          <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-0">
            <span className="font-display text-[1.9rem] uppercase leading-none tracking-notice">NecroLegacy</span>
            <span className="text-xs font-semibold uppercase tracking-label text-muted-foreground">
              Digital autopsy workbench
            </span>
          </h1>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {sourceName && (
              <p className="flex min-w-0 items-center gap-2 text-sm">
                <span className="label">Active dump</span>
                <span className="truncate font-mono text-foreground">{sourceName}</span>
              </p>
            )}
            <Button type="button" onClick={() => setDropzoneOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              New autopsy
            </Button>
          </div>
        </div>
      </header>

      <DropzoneModal client={client} onSession={onSession} open={dropzoneOpen} onOpenChange={setDropzoneOpen} />

      <main className="mx-auto grid w-full max-w-[96rem] flex-1 gap-x-10 gap-y-8 px-4 py-8 md:px-8 lg:grid-cols-[17.5rem_minmax(0,1fr)] lg:[grid-template-areas:'aside_notice'_'aside_table']">
        <div className="flex flex-col gap-4 lg:[grid-area:notice]">
          <CoronersNotice
            phase={state.phase}
            sourceName={sourceName}
            currentNode={state.currentNode}
            entities={entities}
            anomalies={anomalies}
            servedFromCache={state.servedFromCache}
          />
          {state.servedFromCache && (
            <p role="note" className="text-sm text-muted-foreground">
              Served from cache: this result was computed earlier.
            </p>
          )}
          {state.connection.status === "reconnecting" && (
            <p role="status" className="text-sm text-tallow">
              Reconnecting (attempt {state.connection.attempt})…
            </p>
          )}
          {state.connection.status === "lost" && (
            <div role="alert" className="flex flex-wrap items-center gap-3 border border-crimson/60 bg-crimson/10 p-3 text-sm">
              <span>Connection lost. Progress so far is kept.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!sessionId) return;
                  dispatch({ type: "connection_ok" });
                  connect(sessionId);
                }}
              >
                Retry connection
              </Button>
            </div>
          )}
          {state.phase === "failed" && (
            <p role="alert" className="border border-crimson/60 bg-crimson/10 p-3 text-sm">
              The autopsy failed. Partial results are shown where available.
            </p>
          )}
        </div>

        <aside aria-label="Case file" className="flex flex-col gap-8 lg:[grid-area:aside]">
          <section aria-labelledby="procedure-heading">
            <h2 id="procedure-heading" className="label border-b border-border pb-2">
              Procedure
            </h2>
            {idle ? (
              <p className="pt-3 text-sm text-muted-foreground">
                Upload a legacy dump or choose a preset to begin the autopsy.
              </p>
            ) : (
              <ProgressRail events={events} />
            )}
          </section>
          <section aria-labelledby="specimens-heading" className="flex flex-col gap-3">
            <h2 id="specimens-heading" className="label">
              Specimens
            </h2>
            {entities.length > 0 ? (
              <EntityList entities={entities} anomalies={anomalies} onOpen={openEntity} highlightedIds={highlighted} />
            ) : (
              <p className="border-y border-border py-3 text-sm text-muted-foreground">
                {idle ? "Nothing on the table yet." : "Recovering entities…"}
              </p>
            )}
            <AutopsySummary id={SUMMARY_ID} entities={entities} anomalies={anomalies} />
          </section>
        </aside>

        <div className={showXRay ? "grid min-w-0 gap-6 lg:[grid-area:table] xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" : "min-w-0 lg:[grid-area:table]"}>
          {showXRay && state.vision && imageUrl && (
            <section aria-label="Uploaded image" className="min-w-0">
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
            <img src={imageUrl} alt="Uploaded document" className="max-h-64 w-auto border border-border object-contain" />
          )}

          <div className="flex min-w-0 flex-col gap-2">
            <div
              ref={canvasRegionRef}
              tabIndex={-1}
              className="lamp-pool relative h-[clamp(22rem,56vh,38rem)] overflow-hidden border border-border"
            >
              {idle ? (
                <div className="grid h-full place-items-center p-6 text-center">
                  <div className="flex max-w-sm flex-col items-center gap-4">
                    <p className="text-sm text-muted-foreground">
                      The table is empty. Specimens appear here as a 3D constellation once the procedure starts.
                    </p>
                    {!dropzoneOpen && (
                      <Button type="button" variant="outline" onClick={() => setDropzoneOpen(true)}>
                        Open the intake
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <AutopsyCanvasDynamic
                  entities={entities}
                  anomalies={anomalies}
                  graph={graph}
                  highlightedIds={highlighted}
                  summaryId={SUMMARY_ID}
                  onSelect={(id) => openEntity(id, null)}
                  onOpenEntity={openEntity}
                />
              )}
            </div>
            {entities.length > 0 && (
              <ul aria-label="Table legend" className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-crimson" /> Critical rot, traced along its links
                </li>
                <li className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ochre" /> Low or medium findings
                </li>
                <li className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-foreground" /> Healthy, steady pulse
                </li>
                <li>Drag to orbit · select a specimen to open its evidence</li>
              </ul>
            )}
          </div>
        </div>
      </main>

      {sessionId && (state.schema || state.resurrection) && (
        <div className="border-t border-border">
          <div className="mx-auto grid w-full max-w-[96rem] gap-x-10 gap-y-12 px-4 py-10 md:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {state.schema ? (
              <SearchPanel client={client} sessionId={sessionId} onHits={(hits) => dispatch({ type: "search_results", hits })} />
            ) : (
              <div />
            )}
            <GeneratedCodeView resurrection={state.resurrection} />
          </div>
        </div>
      )}

      <NodeInspector
        entity={selected}
        anomalies={anomalies}
        open={inspectorOpen && selected !== null}
        onOpenChange={setInspectorOpen}
        opener={opener}
        returnFocusRef={canvasRegionRef}
      />
    </div>
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
