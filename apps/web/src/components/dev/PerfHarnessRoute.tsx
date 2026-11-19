"use client";

import { useSearchParams } from "next/navigation";
import { PerfHarness } from "./PerfHarness";

// Reads the mode in the browser so the route can be part of a static export.
export function PerfHarnessRoute() {
  const mode = useSearchParams().get("mode");
  return <PerfHarness mode={mode === "scene" ? "scene" : "xray"} />;
}
