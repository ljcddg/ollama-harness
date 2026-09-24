/**
 * Inline SVG icons for the chrome.
 *
 * These exist instead of emoji because emoji are a font dependency the app
 * cannot verify. `🗂` (U+1F5C2) and `📌` (U+1F4CC) render as solid `.notdef`
 * boxes wherever the emoji font is missing or the fallback chain is short, and
 * a box in the sidebar reads as corrupted text rather than as a missing icon.
 *
 * Two more reasons to prefer SVG here:
 *   - `⌄` (U+2304) and `⋯` (U+22EF) live in symbol blocks that ordinary UI fonts
 *     often lack, so they are just as fragile as the emoji.
 *   - `currentColor` means an icon picks up the hover/active/muted colour of
 *     whatever row it sits in, which no emoji does.
 *
 * All icons share one grid (`viewBox="0 0 16 16"`) and one stroke weight, so
 * they line up optically at the same font size.
 */

interface IconProps {
  /** Rendered size in px. Defaults to 1em so it tracks the surrounding text. */
  size?: number
  className?: string
}

const BASE = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

function sizeProps({ size, className }: IconProps) {
  return {
    width: size ?? '1em',
    height: size ?? '1em',
    className,
  }
}

/** A folder, used to mark a working-directory group. */
export function IconFolder(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.29l.9.9a1 1 0 0 0 .7.29h5.4a1 1 0 0 1 1 1v6.02a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  )
}

/** An opened folder, for "start a conversation in another folder". */
export function IconFolderOpen(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M1.75 12.5V4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.29l.9.9a1 1 0 0 0 .7.29h4.4a1 1 0 0 1 1 1v1.02" />
      <path d="M1.75 12.5 3.4 7.6a1 1 0 0 1 .95-.7h11a.6.6 0 0 1 .57.78l-1.4 4.9a1 1 0 0 1-.96.72H2.75a1 1 0 0 1-1-.8z" />
    </svg>
  )
}

/** A pin, marking a session pinned to the top of its group. */
export function IconPin(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M9.6 1.9 14 6.3l-1.5 1.5-1-.3-2.6 2.6.4 2.3-1.3 1.3L4 9.7l-2.1-4 1.3-1.3 2.3.4 2.6-2.6-.3-1z" />
      <path d="M4.1 11.9 1.9 14.1" />
    </svg>
  )
}

/** Three dots, for an overflow menu. */
export function IconDots(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)} strokeWidth={0} fill="currentColor">
      <circle cx="3.5" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.5" cy="8" r="1.35" />
    </svg>
  )
}

/** A chevron, pointing down when expanded. CSS rotates it when collapsed. */
export function IconChevron(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  )
}

/** A plus, for "new conversation" and per-group add. */
export function IconPlus(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

/** A gear, for settings. */
export function IconGear(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" />
    </svg>
  )
}

/** A document, for an attached-file chip. */
export function IconFile(props: IconProps) {
  return (
    <svg {...BASE} {...sizeProps(props)}>
      <path d="M9 1.9H4.4a1 1 0 0 0-1 1v10.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.6z" />
      <path d="M9 1.9v3.7h3.6" />
    </svg>
  )
}
