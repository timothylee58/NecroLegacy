// Hand-drawn theatre motifs. All are decorative (aria-hidden); meaning always lives in text or labels nearby.
import type { CSSProperties, SVGProps } from "react";
import { cn } from "@/lib/utils";

type Props = SVGProps<SVGSVGElement>;

const base = { "aria-hidden": true, focusable: false } as const;

export function Bat({ className, ...props }: Props) {
  return (
    <svg {...base} viewBox="0 0 64 28" className={cn("fill-current", className)} {...props}>
      <path d="M32 9c1.6 0 2.6 1 3 2.4l1.6-2.6.4 3.6c6-4.6 14-6.6 24-4.4-3.2 1.8-4.8 4.4-4.8 7.6-2.8-1.4-5.8-1.4-8.8.2.4 2-.2 4-1.8 5.6-2.4-2.6-6-3.8-10.6-3.6L32 26l-3.4-8.2c-4.6-.2-8.2 1-10.6 3.6-1.6-1.6-2.2-3.6-1.8-5.6-3-1.6-6-1.6-8.8-.2 0-3.2-1.6-5.8-4.8-7.6 10-2.2 18-.2 24 4.4l.4-3.6 1.6 2.6C29.4 10 30.4 9 32 9z" />
    </svg>
  );
}

/** A bat whose wings flap while it crosses its container along `bat-cross` (or a custom animation). */
export function FlyingBat({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" className={cn("pointer-events-none absolute block", className)} style={style}>
      <Bat className="bat-flap block h-full w-full" />
    </span>
  );
}

export function SurgicalLamp({ className, ...props }: Props) {
  return (
    <svg {...base} viewBox="0 0 160 64" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} {...props}>
      <path d="M80 0v18" />
      <rect x="72" y="18" width="16" height="6" rx="1" />
      <path d="M40 50c4-18 20-26 40-26s36 8 40 26" />
      <path d="M34 50h92" strokeWidth={2} />
      <ellipse cx="80" cy="53" rx="20" ry="3.5" className="fill-tallow stroke-none lamp-bulb" />
    </svg>
  );
}

/** A web spun from the top-left corner; mirror it with a CSS transform for other corners. */
export function Cobweb({ className, ...props }: Props) {
  const spokes = [0, 22, 45, 68, 90].map((deg) => (deg * Math.PI) / 180);
  const at = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const;
  const rings = [28, 58, 92].map((r) =>
    spokes
      .slice(1)
      .map((a, i) => {
        const [x0, y0] = at(r, spokes[i]!);
        const [x1, y1] = at(r, a);
        const [cx, cy] = at(r * 0.82, (a + spokes[i]!) / 2);
        return `${i === 0 ? `M${x0.toFixed(1)} ${y0.toFixed(1)}` : ""}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
      })
      .join(""),
  );
  return (
    <svg {...base} viewBox="0 0 110 110" fill="none" stroke="currentColor" strokeWidth={0.8} className={className} {...props}>
      {spokes.map((a) => {
        const [x, y] = at(110, a);
        return <path key={a} d={`M0 0L${x.toFixed(1)} ${y.toFixed(1)}`} />;
      })}
      {rings.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function Candle({ className, lit = true, ...props }: Props & { lit?: boolean }) {
  return (
    <svg {...base} viewBox="0 0 16 28" fill="none" stroke="currentColor" strokeWidth={1.4} className={className} {...props}>
      <rect x="4.5" y="12" width="7" height="14.5" rx="1" />
      <path d="M8 12V9" />
      {lit && <path d="M8 1c2.6 3 3 5.6 0 8.6C5 6.6 5.4 4 8 1z" className="candle-flame fill-tallow stroke-none" />}
    </svg>
  );
}

export function Coffin({ className, ...props }: Props) {
  return (
    <svg {...base} viewBox="0 0 44 64" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" className={className} {...props}>
      <path d="M14 2h16l12 14-8 46H10L2 16z" />
      <path d="M22 14v24M15 22h14" />
    </svg>
  );
}

export function ToeTag({ className, ...props }: Props) {
  return (
    <svg {...base} viewBox="0 0 34 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" className={className} {...props}>
      <path d="M12 1h19.5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H12L5 8z" />
      <circle cx="12.5" cy="8" r="1.6" />
      <path d="M11 8C7 3 3 3 .5 5" />
    </svg>
  );
}

/** The empty autopsy table: a draped specimen on a steel slab, its toe tag hanging off the end. */
export function AutopsySlab({ className, ...props }: Props) {
  return (
    <svg {...base} viewBox="0 0 320 160" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" className={className} {...props}>
      <path
        d="M58 92c8-20 32-26 50-20 14-12 40-13 56-3 20-9 50-7 70 3 14-2 28 8 34 20z"
        className="fill-foreground/[0.06]"
      />
      <path d="M96 78c10 4 22 4 30-2M176 70c8 6 22 8 34 4" strokeWidth={1} opacity={0.5} />
      <path d="M26 92h268l8 12H18z" />
      <path d="M18 104h284v7H18z" />
      <circle cx="160" cy="107.5" r="1.8" />
      <path d="M70 111l-9 38M250 111l9 38M64 137h192" />
      <ToeTagAt />
    </svg>
  );
}

function ToeTagAt() {
  // Drawn in slab coordinates so it hangs from the draped feet at the right end of the table.
  return (
    <g transform="translate(270 96) rotate(72)" strokeWidth={1.2}>
      <path d="M8 -5h15a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8l-5-5z" className="fill-background" />
      <circle cx="8.5" cy="0" r="1.2" />
    </g>
  );
}

/** Two drifting fog layers along the bottom of a positioned container. */
export function Fog({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("fog pointer-events-none absolute inset-x-0 bottom-0", className)} />;
}
