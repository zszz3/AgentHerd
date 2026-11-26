// The AgentHerd mark: a monochrome pixel lead pet flanked by two smaller companions and a
// pixel sparkle on an inverted tile. Drawn inline, no assets; same shape as resources/icon.svg.

const HERO_PATH =
  "M15 27H16V25H17V23H18V22H19V18H20V17H23V18H24V19H30V18H31V17H34V18H35V22H36V23H37V25H38V27H39V33H38V35H37V36H36V37H34V39H31V38H23V39H20V37H18V36H17V35H16V33H15Z M22 27H24V23H22Z M30 27H32V23H30Z";
const MINIS_PATH =
  "M8 26V27H9V28H11V27H12V26H14V27H15V31H16V35H15V36H14V39H12V38H8V39H6V36H5V35H4V31H5V27H6V26Z M8 33V30H7V33Z M13 30H12V33H13Z " +
  "M42 38V39H40V36H39V35H38V31H39V27H40V26H42V27H43V28H45V27H46V26H48V27H49V31H50V35H49V36H48V39H46V38Z M41 33H42V30H41Z M46 30V33H47V30Z";
const STAR_PATH = "M38 10H39V9H40V10H41V11H42V12H41V13H40V14H39V13H38V12H37V11H38Z";

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 54 54"
      role="img"
      aria-label="AgentHerd"
      className="shrink-0"
    >
      <rect width="54" height="54" rx="13.5" fill="var(--ah-invert)" />
      <path d={MINIS_PATH} fill="var(--ah-on-invert)" fillRule="evenodd" opacity="0.55" />
      <path d={HERO_PATH} fill="var(--ah-on-invert)" fillRule="evenodd" />
      <path d={STAR_PATH} fill="var(--ah-on-invert)" />
      <rect x="43" y="13" width="1.2" height="1.2" fill="var(--ah-on-invert)" opacity="0.65" />
    </svg>
  );
}
