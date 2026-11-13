import type { ReactNode, SVGProps } from 'react';

/**
 * Payments' own nav and empty-state glyphs: 16×16 strokes in currentColor, drawn like the kit's
 * (`agora-kit/icons.tsx`) so the sidebar reads as one set.
 */

function stroke(paths: ReactNode) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** The console mark: a coin with a stroke through it. */
export const PaymentsMark = stroke(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5v7M6.2 6.6h2.6a1.2 1.2 0 0 1 0 2.4H7.4" />
  </>,
);
/** Overview: a gauge. */
export const GaugeIcon = stroke(
  <>
    <path d="M2.5 11a5.5 5.5 0 1 1 11 0" />
    <path d="M8 11l2.5-3" />
  </>,
);
/** Payments: a card. */
export const CardIcon = stroke(
  <>
    <rect x="1.75" y="3.5" width="12.5" height="9" rx="1.5" />
    <path d="M1.75 6.5h12.5M4.5 10h2.5" />
  </>,
);
/** Subscriptions: a repeat loop. */
export const RepeatIcon = stroke(
  <>
    <path d="M2.5 7V6a2 2 0 0 1 2-2h8.5M11 2l2 2-2 2" />
    <path d="M13.5 9v1a2 2 0 0 1-2 2H3M5 14l-2-2 2-2" />
  </>,
);
/** Disputes: a shield with a mark. */
export const ShieldIcon = stroke(
  <>
    <path d="M8 1.75 13 3.5v4c0 3-2.2 5.3-5 6.75C5.2 12.8 3 10.5 3 7.5v-4z" />
    <path d="M8 5.5v3M8 10.75v.01" />
  </>,
);
/** Webhook events: a plug. */
export const PlugIcon = stroke(
  <>
    <path d="M5.5 1.75v3M10.5 1.75v3M3.75 4.75h8.5V7a4.25 4.25 0 0 1-8.5 0z" />
    <path d="M8 11.25v3" />
  </>,
);
/** Activity (the audit log): a list with a clock. */
export const LogIcon = stroke(
  <>
    <path d="M2 3.5h7M2 7h5M2 10.5h4" />
    <circle cx="11.5" cy="10.5" r="3" />
    <path d="M11.5 9.2v1.4l.9.6" />
  </>,
);
/** An organization (the topbar picker). */
export const BuildingIcon = stroke(
  <>
    <rect x="3" y="2" width="10" height="12" rx="1" />
    <path d="M6 5h1M9 5h1M6 8h1M9 8h1M7 14v-2.5h2V14" />
  </>,
);
