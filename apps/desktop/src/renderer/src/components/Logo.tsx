// The AgentHerd mark: a small figure with two eyes standing at the bottom of an inverted tile,
// like the pet in its corner of the screen. Drawn inline, no assets; same shape as
// resources/icon.svg.

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="AgentHerd"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="8" fill="var(--ah-invert)" />
      <path
        d="M6.3 32V17.9C6.3 12.9 10.3 9.6 16 9.6S25.7 12.9 25.7 17.9V32Z"
        fill="var(--ah-on-invert)"
      />
      <rect x="12.9" y="15.6" width="2" height="4" rx="1" fill="var(--ah-invert)" />
      <rect x="17.1" y="15.6" width="2" height="4" rx="1" fill="var(--ah-invert)" />
    </svg>
  );
}
