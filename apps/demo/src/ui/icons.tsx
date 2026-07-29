import type { ReactNode, SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number | string
}

function LineIcon({
  children,
  size = 24,
  ...props
}: IconProps & { children: ReactNode }) {
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby'])

  return (
    <svg
      {...props}
      aria-hidden={labelled ? undefined : true}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  )
}

export function AirplaneIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="m3.5 14.5 7-2.2V5.7c0-1.4.7-2.7 1.5-2.7s1.5 1.3 1.5 2.7v6.6l7 2.2v1.8l-7-.8v3.7l2.2 1.3v1L12 20.8l-3.7.7v-1l2.2-1.3v-3.7l-7 .8z" />
    </LineIcon>
  )
}

export function LocationIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </LineIcon>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </LineIcon>
  )
}

export function NavigationIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="m20.5 3.5-7.2 17-2.2-7.2-7.6-2.8z" />
      <path d="m11.1 13.3 4-4" />
    </LineIcon>
  )
}

export function BatteryIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect height="12" rx="2" width="17" x="2" y="6" />
      <path d="M22 10v4M6 10v4M10 10v4M14 10v4" />
    </LineIcon>
  )
}

export function ChargingIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="m13.5 2-7 11H12l-1.5 9 7-12H12z" />
    </LineIcon>
  )
}

export function SeatIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="8" cy="5" r="2.5" />
      <path d="M6.5 9v5.2c0 1.5 1.2 2.8 2.8 2.8H16l2 4M9 11.5h5.5l2.5 5M4 21h12" />
    </LineIcon>
  )
}

export function MediaIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M9 18V6l10-2v12" />
      <path d="M9 11.5 19 9.5" />
      <ellipse cx="6.5" cy="18" rx="2.5" ry="2" />
      <ellipse cx="16.5" cy="16" rx="2.5" ry="2" />
    </LineIcon>
  )
}

export function CompleteIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.7 2.7L16.5 9" />
    </LineIcon>
  )
}

export function MessageIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-5.2A3 3 0 0 1 3 13.5V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z" />
      <path d="M7 9h10M7 13h6" />
    </LineIcon>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </LineIcon>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10.3 4.2 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </LineIcon>
  )
}

export function MicrophoneIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect height="11" rx="4" width="7" x="8.5" y="2.5" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </LineIcon>
  )
}

export function KeyboardIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect height="13" rx="2.5" width="20" x="2" y="5.5" />
      <path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 9.5h.01M9.5 13h5M18 13h.01" />
    </LineIcon>
  )
}

export function ControlsIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 6h4M12 6h8M4 12h10M18 12h2M4 18h2M10 18h10" />
      <circle cx="10" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="8" cy="18" r="2" />
    </LineIcon>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 12h14M14 7l5 5-5 5" />
    </LineIcon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </LineIcon>
  )
}

// Short alias for callers that use the compact control-bar name.
export const MicIcon = MicrophoneIcon
