// A split tally: the books are the top half, Airwallex the bottom. When it
// scrolls into view the halves meet, a line runs the seam, and the one notch
// that only the bank has glows ember red until the matching cut is made.

const SEAM = 120;
const LEFT = 60;

interface Notch {
  x: number;
  w: number;
  top?: string;
  bottom?: string;
  /** Present on the bank half only, until the fix cuts it into the books. */
  break?: boolean;
}

const NOTCHES: Notch[] = [
  { x: 150, w: 40, top: "30,000.00", bottom: "deposit" },
  { x: 270, w: 30, top: "6,000.00", bottom: "FXP-118" },
  { x: 380, w: 26, top: "3,200.00", bottom: "FXP-119" },
  { x: 490, w: 22, top: "2,000.00", bottom: "INV-2041" },
  { x: 600, w: 28, top: "4,000.00", bottom: "INV-2044" },
  { x: 715, w: 30, top: "7,250.00", bottom: "INV-2047" },
  { x: 830, w: 20, break: true },
  { x: 945, w: 30, top: "9,800.00", bottom: "INV-2050" },
  { x: 1050, w: 26, top: "3,200.00", bottom: "INV-2039" },
];

const BREAK_X = NOTCHES.find((n) => n.break)!.x;
const depth = (w: number) => Math.max(10, w * 0.55);
const vUp = (n: Notch) => `${n.x - n.w / 2},${SEAM} ${n.x},${SEAM - depth(n.w)} ${n.x + n.w / 2},${SEAM}`;
const vDown = (n: Notch) => `${n.x - n.w / 2},${SEAM} ${n.x},${SEAM + depth(n.w)} ${n.x + n.w / 2},${SEAM}`;
const diamond = (n: Notch) =>
  `${n.x - n.w / 2},${SEAM} ${n.x},${SEAM - depth(n.w)} ${n.x + n.w / 2},${SEAM} ${n.x},${SEAM + depth(n.w)}`;

/** Scan reaches each notch in time, so its flash is a consequence of the line passing. */
const flashDelay = (x: number) => 1.6 + ((x - LEFT) / (BREAK_X - LEFT)) * 1.24;

export function Tally({ play = true, wrong, fixed, id = "t" }: { play?: boolean; wrong: string; fixed: string; id?: string }) {
  return (
    <figure className="tally-stage">
      <svg
        className={`tally${play ? " play" : ""}`}
        viewBox="0 0 1200 250"
        role="img"
        aria-label={`A split tally stick. Top half: the books. Bottom half: Airwallex. One notch exists only on the bank half: ${wrong}. After the fix: ${fixed}.`}
        style={{ ["--scan-to" as string]: `${BREAK_X - LEFT}px` }}
      >
        <defs>
          <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <clipPath id={`${id}-top`}>
            <path d={`M${LEFT} ${SEAM} V84 Q${LEFT} 64 80 64 H1110 L1140 ${SEAM} Z`} />
          </clipPath>
          <clipPath id={`${id}-bottom`}>
            <path d={`M${LEFT} ${SEAM} H1140 L1110 176 H80 Q${LEFT} 176 ${LEFT} 156 Z`} />
          </clipPath>
        </defs>

        {/* Books: the company's half */}
        <g className="half top">
          <g clipPath={`url(#${id}-top)`}>
            <rect className="wood" x={LEFT} y="60" width="1090" height="62" />
            {[74, 86, 99, 110].map((y, i) => (
              <path key={y} className="grain" d={`M${LEFT} ${y} C 300 ${y - 4 + i}, 520 ${y + 5}, 760 ${y - 2} S 1040 ${y + 3}, 1150 ${y - 1}`} />
            ))}
          </g>
          <path className="bark" d={`M${LEFT} ${SEAM} V84 Q${LEFT} 64 80 64 H1110 L1140 ${SEAM}`} />
          <text className="side" x="84" y="100">BOOKS</text>
          {NOTCHES.filter((n) => !n.break).map((n) => (
            <polygon key={n.x} className="cut" points={vUp(n)} />
          ))}
          <polygon
            className="cut knife"
            points={vUp(NOTCHES.find((n) => n.break)!)}
            style={{ transformOrigin: `${BREAK_X}px ${SEAM}px` }}
          />
          {NOTCHES.filter((n) => n.top).map((n) => (
            <text key={n.x} className="amt" x={n.x} y="46" textAnchor="middle">{n.top}</text>
          ))}
        </g>

        {/* Airwallex: the bank's half */}
        <g className="half bottom">
          <g clipPath={`url(#${id}-bottom)`}>
            <rect className="wood" x={LEFT} y="118" width="1090" height="62" />
            {[132, 145, 158, 168].map((y, i) => (
              <path key={y} className="grain" d={`M${LEFT} ${y} C 260 ${y + 3}, 560 ${y - 5 + i}, 800 ${y + 2} S 1060 ${y - 3}, 1150 ${y + 1}`} />
            ))}
          </g>
          <path className="bark" d={`M${LEFT} ${SEAM} V156 Q${LEFT} 176 80 176 H1110 L1140 ${SEAM}`} />
          <text className="side" x="84" y="153">AIRWALLEX</text>
          {NOTCHES.map((n) => (
            <polygon key={n.x} className="cut" points={vDown(n)} />
          ))}
          {NOTCHES.filter((n) => n.bottom).map((n) => (
            <text key={n.x} className="amt" x={n.x} y="204" textAnchor="middle">{n.bottom}</text>
          ))}
        </g>

        <line className="seam" x1={LEFT} x2="1140" y1={SEAM} y2={SEAM} />

        {/* The audit: matched notches flash as the line passes */}
        {NOTCHES.filter((n) => !n.break).map((n) =>
          n.x < BREAK_X ? (
            <polygon key={n.x} className="flash" points={diamond(n)} style={{ animationDelay: `${flashDelay(n.x).toFixed(2)}s` }} />
          ) : null,
        )}
        <g className="bad">
          <polygon points={vDown(NOTCHES.find((n) => n.break)!)} filter={`url(#${id}-glow)`} transform={`translate(0 2)`} />
          <polygon points={vDown(NOTCHES.find((n) => n.break)!)} />
        </g>
        <circle className="ping" cx={BREAK_X} cy={SEAM} r="30" style={{ transformOrigin: `${BREAK_X}px ${SEAM}px` }} />
        <line className="scan" x1={LEFT} x2={LEFT} y1="56" y2="184" />

        <g className="callout wrong">
          <line x1={BREAK_X} x2={BREAK_X} y1="186" y2="218" />
          <text x={BREAK_X} y="238" textAnchor="middle">{wrong}</text>
        </g>
        <g className="callout fixed">
          <line x1={BREAK_X} x2={BREAK_X} y1="186" y2="218" />
          <text x={BREAK_X} y="238" textAnchor="middle">{fixed}</text>
        </g>
      </svg>
      <figcaption className="tally-caption mono">
        {wrong ? <><span className="ember">{wrong}</span> <span className="dim">then</span> </> : null}
        <span className="settled">{fixed}</span>
      </figcaption>
    </figure>
  );
}
