// A fixed scatter, worked out on the server, so every visit gets the same sparks.
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Sparks lifting off the fire in the painting, between `from` and `to` percent across. */
export function Embers({ count, from, to }: { count: number; from: number; to: number }) {
  return (
    <div className="embers" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i
          key={i}
          style={
            {
              "--x": `${(from + rand(i, 1) * (to - from)).toFixed(1)}%`,
              "--y": `${(rand(i, 2) * 40).toFixed(1)}%`,
              "--s": `${(2.5 + rand(i, 3) * 3).toFixed(1)}px`,
              "--t": `${(8 + rand(i, 4) * 9).toFixed(1)}s`,
              "--d": `${(-rand(i, 5) * 17).toFixed(1)}s`,
              "--dx": `${((rand(i, 6) - 0.5) * 140).toFixed(0)}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
