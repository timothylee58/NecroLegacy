import { notFound } from "next/navigation";
import { StressHarness } from "./StressHarness";

// Mock-mode only: the harness exists for the Playwright rendering test and must not ship in a live deployment.
export default function StressPage() {
  if (process.env.NEXT_PUBLIC_USE_MOCK !== "true") notFound();
  return <StressHarness />;
}
