# Design Language — "Personal JARVIS"

PakOS looks like a command center from the near future, not a fantasy
console. Modern, fast, minimal, mobile-first. **Function always beats
visual effects** — if an effect costs clarity or frame rate, cut it.

## Palette

| Token | Value | Use |
|---|---|---|
| `--bg` | `#000000` | OLED true black canvas |
| `--glass` | `rgba(16, 22, 28, 0.62)` + `backdrop-blur` | panel surfaces |
| `--line` | `rgba(94, 234, 212, 0.10)` | hairline panel borders |
| `--cyan` | `#22d3ee` | primary lighting, active states, links |
| `--teal` | `#2dd4bf` | success, healthy, "operational" |
| `--purple` | `#a78bfa` | secondary accent: review states, agent/crew hints |
| `--amber` | `#fbbf24` | warnings (dirty repos, stale scans) |
| `--red` | `#f87171` | errors only |
| `--text` | `#e6f1f3` | primary text |
| `--muted` | `#7c9299` | secondary text |

Rules of thumb:

- Cyan/teal is *light*, not paint: use it for glows, borders, indicators
  and key numbers — never for large fills.
- Purple is rare. If purple is everywhere, it's wrong.
- Semantic colors (amber/red) always mean something; never decorative.

## Surfaces — glassmorphism, restrained

- Panels: translucent dark glass (`--glass`) with `backdrop-filter:
  blur(16px)`, 1px `--line` border, 16px radius.
- One soft inner top-edge highlight per panel max — the "holographic"
  read comes from layered translucency, not from gradients everywhere.
- OLED black shows through between panels; keep real gaps.

## Motion

- Animated status indicators: slow 2s pulse on live dots, subtle glow.
- Transitions ≤ 200ms, ease-out, opacity/transform only (compositor-safe).
- Respect `prefers-reduced-motion: reduce` — all pulses stop.

## Typography

- System stack: SF Pro / -apple-system for prose; `ui-monospace` for
  hashes, branches, counts, and anything data-like.
- Section headers: 11px uppercase, 2px letter-spacing, cyan.
- No custom webfonts (self-contained page, no network fetches).

## Iconography & texture

- Line-weight icons, geometric, no emoji in the final UI shell.
- Mech/robotics inspiration from Holobots: modular panel shapes, status
  readouts, "systems" language (CREW, MISSIONS, SYSTEMS) — but abstract
  and clean, never skeuomorphic or game-styled.

## What to avoid

- Fantasy/sci-fi kitsch: scanlines, fake terminals, glitch effects.
- Neon-on-everything; more than two glowing elements per viewport.
- Framework/CSS-lib imports for polish — this page stays hand-built.
