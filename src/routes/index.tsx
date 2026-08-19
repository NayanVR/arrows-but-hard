import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const Route = createFileRoute('/')({ component: Home })

type Dir = 'up' | 'down' | 'left' | 'right'
type Pt = { r: number; c: number }
type Arrow = { id: number; cells: Pt[]; dir: Dir; gone: boolean } // cells: tail -> head

const DELTA: Record<Dir, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
}
const DIRS: Dir[] = ['up', 'down', 'left', 'right']
const rand = (n: number) => (Math.random() * n) | 0
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const key = (r: number, c: number) => r + ',' + c

const LEVEL_COUNT = 120

// Piecewise growth. Segments (length, rate): fastest for 1-20, then easing off.
function ramp(level: number, base: number, segs: [number, number][]) {
  let v = base
  let n = level
  for (const [len, rate] of segs) {
    const used = Math.min(n, len)
    v += used * rate
    n -= used
    if (n <= 0) break
  }
  return Math.floor(v)
}
function shape(level: number) {
  // 1-10 (ferocious ramp: level 10 lands around where level 60 used to sit) ->
  // 10-50 (steep) -> 50-85 (moderate) -> 85-120 (gentle, but still climbing)
  const cols = ramp(level, 6, [[10, 3.7], [40, 0.6], [35, 0.35], [35, 0.2]]) // ~43 @10, ~67 @50, ~79 @85, ~86 @120
  const rows = ramp(level, 7, [[10, 4.8], [40, 0.75], [35, 0.45], [35, 0.25]]) // ~55 @10, ~85 @50, ~101 @85, ~109 @120
  const maxTrail = ramp(level, 4, [[10, 2.8], [40, 0.45], [35, 0.28], [35, 0.15]]) // ~32 @10, ~50 @50, ~60 @85, ~65 @120
  // Floor on trail length so short, obviously-aimed 2-cell arrows get rarer as levels climb.
  const minTrail = clamp(2 + Math.floor(level / 8), 2, maxTrail - 1)
  return { cols, rows, maxTrail, minTrail }
}

// Center-first reverse placement. Each cell, from the board centre outward, seeds
// a trail whose head's straight ray to the edge is clear of already-placed arrows;
// the trail never enters that ray. Placing centre cells first (they're removed
// last, exiting through paths later removals clear) packs the board densely, and
// removing in reverse placement order is always valid — so every board is solvable.
function shuffled<T>(arr: T[]) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function generate(level: number) {
  const { cols, rows, maxTrail, minTrail } = shape(level)
  const inb = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols
  const occ = new Set<string>()
  const arrows: Arrow[] = []
  let id = 0

  // Forward ray from a head cell to the edge; null if blocked by a placed arrow.
  const clearRay = (r: number, c: number, dr: number, dc: number) => {
    const ray = new Set<string>()
    let rr = r + dr
    let cc = c + dc
    while (inb(rr, cc)) {
      if (occ.has(key(rr, cc))) return null
      ray.add(key(rr, cc))
      rr += dr
      cc += dc
    }
    return ray
  }

  // Cells ordered centre-first (distance from nearest edge, descending; ties random).
  const order: { r: number; c: number; d: number }[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) order.push({ r, c, d: Math.min(r, rows - 1 - r, c, cols - 1 - c) + Math.random() })
  order.sort((a, b) => b.d - a.d)

  for (const { r, c } of order) {
    if (occ.has(key(r, c))) continue
    // Direction order is shuffled rather than nearest-edge-first: an arrow's exit
    // isn't always the closest wall, so its escape isn't obvious at a glance.
    const dirs = shuffled(DIRS)
    let chosen: { dir: Dir; forbid: Set<string>; back: Pt } | null = null
    for (const dir of dirs) {
      const [dr, dc] = DELTA[dir]
      // The cell straight behind the head must be free: this keeps the arrowhead
      // aligned with its shaft (no sudden turn) and guarantees length >= 2.
      const back = { r: r - dr, c: c - dc }
      if (!inb(back.r, back.c) || occ.has(key(back.r, back.c))) continue
      const forbid = clearRay(r, c, dr, dc)
      if (forbid) {
        chosen = { dir, forbid, back }
        break
      }
    }
    if (!chosen) continue // can't host an aligned length-2 arrow here; leave for a neighbour or the fill pass

    const { dir, forbid, back } = chosen
    const [dr, dc] = DELTA[dir]
    const target = minTrail + rand(maxTrail - minTrail + 1)

    // Grow the tail as a backtracking walk: dead ends pop back to the last
    // branch point and try another neighbour instead of giving up on the spot.
    // A plain greedy walk stalls constantly in a densely packed board, which
    // was quietly producing a flood of short, easy-to-read arrows; tracking
    // the longest path seen (`best`) means a walk that never hits `target`
    // still keeps whatever progress it made instead of unwinding to nothing.
    const cells: Pt[] = [{ r, c }, back]
    const used = new Set([key(r, c), key(back.r, back.c)])
    let best = cells.slice()
    type Frame = { cell: Pt; heading: [number, number]; tried: Set<string> }
    const stack: Frame[] = [{ cell: back, heading: [-dr, -dc], tried: new Set() }]
    let guard = 0
    while (cells.length < target && stack.length && guard++ < target * 40 + 200) {
      const top = stack[stack.length - 1]
      const nbrs = DIRS.map((d) => ({ dd: DELTA[d], r: top.cell.r + DELTA[d][0], c: top.cell.c + DELTA[d][1] })).filter(
        (n) =>
          inb(n.r, n.c) &&
          !occ.has(key(n.r, n.c)) &&
          !used.has(key(n.r, n.c)) &&
          !forbid.has(key(n.r, n.c)) &&
          !top.tried.has(key(n.r, n.c)),
      )
      if (!nbrs.length) {
        stack.pop()
        if (stack.length) {
          used.delete(key(top.cell.r, top.cell.c))
          cells.pop()
          stack[stack.length - 1].tried.add(key(top.cell.r, top.cell.c))
        }
        continue
      }
      // Prefer continuing straight so trails read cleanly and pack tightly.
      const straight = nbrs.filter((n) => n.dd[0] === top.heading[0] && n.dd[1] === top.heading[1])
      const n = straight.length && Math.random() < 0.6 ? straight[0] : nbrs[rand(nbrs.length)]
      top.tried.add(key(n.r, n.c))
      cells.push({ r: n.r, c: n.c })
      used.add(key(n.r, n.c))
      if (cells.length > best.length) best = cells.slice()
      stack.push({ cell: { r: n.r, c: n.c }, heading: [n.dd[0], n.dd[1]], tried: new Set() })
    }
    const finalCells = cells.length >= best.length ? cells : best
    const finalUsed = new Set(finalCells.map((p) => key(p.r, p.c)))
    for (const k of finalUsed) occ.add(k)
    arrows.push({ id: id++, cells: finalCells.slice().reverse(), dir, gone: false })
  }

  // Fill pass: cells no trail ever swept up (all neighbours taken before they came
  // up) still get a single-cell arrow if some direction is clear. Run only after
  // the main loop finishes — placing these immediately, cell by cell, would starve
  // neighbouring trails of room to grow through them, turning otherwise-long trails
  // into a cascade of trivial single-cell arrows instead.
  for (const { r, c } of order) {
    if (occ.has(key(r, c))) continue
    for (const dir of shuffled(DIRS)) {
      const [dr, dc] = DELTA[dir]
      const forbid = clearRay(r, c, dr, dc)
      if (forbid) {
        occ.add(key(r, c))
        arrows.push({ id: id++, cells: [{ r, c }], dir, gone: false })
        break
      }
    }
  }
  return { arrows, cols, rows }
}

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const
const BackIcon = () => (
  <svg {...iconProps}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
)
const RefreshIcon = () => (
  <svg {...iconProps}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)
const CloseIcon = () => (
  <svg {...iconProps}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
const CONFETTI_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899']
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.4,
        dur: 1.8 + Math.random() * 1.6,
        w: 6 + Math.random() * 7,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    [],
  )
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti"
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.w * 0.4,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
          }}
        />
      ))}
    </div>
  )
}

const LockIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)

function Home() {
  const [level, setLevel] = useState(1)
  const [maxLevel, setMaxLevel] = useState(1)
  const [poppingHeart, setPoppingHeart] = useState<number | null>(null)
  const [hearts, setHearts] = useState(3)
  // Empty on the server; generated client-side to avoid SSR/client random mismatch.
  const [{ arrows, cols, rows }, setGame] = useState<ReturnType<typeof generate>>({
    arrows: [],
    cols: 5,
    rows: 6,
  })
  const [status, setStatus] = useState<'playing' | 'won' | 'lost'>('playing')
  const [shaking, setShaking] = useState<number | null>(null)
  const [showLevels, setShowLevels] = useState(false)
  const timers = useRef<number[]>([])

  // Pan/zoom of the board. viewRef mirrors state so gesture handlers read latest.
  const [view, setView] = useState({ s: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  const setV = (next: (v: typeof view) => typeof view) => {
    viewRef.current = next(viewRef.current)
    setView(viewRef.current)
  }
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; s: number } | null>(null)
  const moved = useRef(false)

  function onPointerDown(e: React.PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    pinch.current = null
  }
  function onPointerMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length === 1) {
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true
      setV((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    } else if (pts.length >= 2) {
      moved.current = true
      const [a, b] = pts
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      // ponytail: naive zoom about board centre, no pinch-midpoint anchoring
      if (!pinch.current) pinch.current = { dist, s: viewRef.current.s }
      else setV((v) => ({ ...v, s: clamp(pinch.current!.s * (dist / pinch.current!.dist), 0.6, 3) }))
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }
  function onWheel(e: React.WheelEvent) {
    setV((v) => ({ ...v, s: clamp(v.s * (e.deltaY < 0 ? 1.1 : 0.9), 0.6, 3) }))
  }

  const startLevel = useCallback((lvl: number) => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setLevel(lvl)
    setHearts(3)
    setShaking(null)
    setPoppingHeart(null)
    setStatus('playing')
    setGame(generate(lvl))
    viewRef.current = { s: 1, x: 0, y: 0 }
    setView(viewRef.current)
    localStorage.setItem('arrows-level', String(lvl))
    setMaxLevel((m) => {
      const next = Math.max(m, lvl)
      localStorage.setItem('arrows-max', String(next))
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setMaxLevel(Number(localStorage.getItem('arrows-max') || '1'))
    startLevel(Number(localStorage.getItem('arrows-level') || '1'))
  }, [startLevel])

  function tap(id: number) {
    if (status !== 'playing' || shaking !== null || moved.current) return
    const arrow = arrows.find((a) => a.id === id)
    if (!arrow || arrow.gone) return
    // Cells still occupied by other live arrows.
    const blocked = new Set<string>()
    for (const a of arrows) if (a.id !== id && !a.gone) for (const p of a.cells) blocked.add(key(p.r, p.c))
    const head = arrow.cells[arrow.cells.length - 1]
    const [dr, dc] = DELTA[arrow.dir]
    let rr = head.r + dr
    let cc = head.c + dc
    while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
      if (blocked.has(key(rr, cc))) {
        // Wrong move: shake red, then drop a heart.
        setShaking(id)
        const t = window.setTimeout(() => {
          setShaking(null)
          setHearts((h) => {
            const left = h - 1
            setPoppingHeart(left) // the slot that just emptied jiggles
            if (left <= 0) setStatus('lost')
            return left
          })
        }, 420)
        timers.current.push(t)
        const t2 = window.setTimeout(() => setPoppingHeart(null), 900)
        timers.current.push(t2)
        return
      }
      rr += dr
      cc += dc
    }
    const next = arrows.map((a) => (a.id === id ? { ...a, gone: true } : a))
    setGame({ arrows: next, cols, rows })
    if (next.every((a) => a.gone)) {
      const t = window.setTimeout(() => setStatus('won'), 550)
      timers.current.push(t)
    }
  }

  // Geometry for one arrow: the visible trail plus a straight exit segment past
  // the edge. Escaping animates a dash of length `dashLen` (the trail) sliding
  // forward along this path, so it traces every bend on its way out.
  function pathInfo(a: Arrow) {
    const [dr, dc] = DELTA[a.dir]
    const head = a.cells[a.cells.length - 1]
    const hx = head.c + 0.5
    const hy = head.r + 0.5
    // Single-cell arrow: a short shaft kept inside its own cell (no bleed into
    // neighbours or off the edge). Multi-cell: the real trail through cell centres.
    const trailPts: (readonly [number, number])[] =
      a.cells.length < 2 ? [[hx - dc * 0.34, hy - dr * 0.34], [hx, hy]] : a.cells.map((p) => [p.c + 0.5, p.r + 0.5] as const)
    let dashLen = 0
    for (let i = 1; i < trailPts.length; i++) {
      dashLen += Math.abs(trailPts[i][0] - trailPts[i - 1][0]) + Math.abs(trailPts[i][1] - trailPts[i - 1][1])
    }
    const exitLen = Math.max(rows, cols) + trailPts.length + 1 // clears the board
    const exitEnd = [head.c + 0.5 + dc * exitLen, head.r + 0.5 + dr * exitLen] as const
    const pts = [...trailPts, exitEnd]
    return {
      trail: trailPts.map((p) => `${p[0]},${p[1]}`).join(' '),
      full: pts.map((p) => `${p[0]},${p[1]}`).join(' '),
      dashLen,
      fullLen: dashLen + exitLen,
      exitLen,
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-4 bg-slate-50 px-4 py-6 select-none">
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-4 bg-slate-50 pb-2">
      <div className="flex w-full items-center justify-between">
        <button
          onClick={() => level > 1 && startLevel(level - 1)}
          className="grid size-11 place-items-center rounded-full bg-blue-500 text-white shadow transition active:scale-90 disabled:opacity-40"
          disabled={level <= 1}
          aria-label="Previous level"
        >
          <BackIcon />
        </button>
        <button
          onClick={() => setShowLevels(true)}
          className="rounded-full bg-blue-500 px-6 py-2 font-bold text-white shadow transition active:scale-95 hover:bg-blue-600"
        >
          Level {level}
        </button>
        <button
          onClick={() => startLevel(level)}
          className="grid size-11 place-items-center rounded-full bg-blue-500 text-white shadow transition active:scale-90 active:rotate-180 hover:bg-blue-600"
          aria-label="Restart level"
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="flex gap-2 text-2xl">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`${i < hearts ? 'text-red-500' : 'text-slate-300'} ${poppingHeart === i ? 'heart-pop' : ''}`}
          >
            {i < hearts ? '♥' : '♡'}
          </span>
        ))}
      </div>
      </div>

      <div
        className="relative w-full max-w-sm touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: 'center' }}>
          <div className="rounded-2xl bg-white p-2 shadow-lg">
            <svg viewBox={`0 0 ${cols} ${rows}`} className="w-full" style={{ overflow: 'visible' }}>
          <defs>
            <marker id="head" viewBox="0 0 10 10" refX="4.9" refY="5" markerWidth="0.5" markerHeight="0.5" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M1,2 L8.2,5 L1,8 z" fill="#1f2937" stroke="#1f2937" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
            </marker>
            <marker id="headRed" viewBox="0 0 10 10" refX="4.9" refY="5" markerWidth="0.5" markerHeight="0.5" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M1,2 L8.2,5 L1,8 z" fill="#ef4444" stroke="#ef4444" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
            </marker>
          </defs>

          {/* dotted plane: a dot in the centre of each cell */}
          {Array.from({ length: rows * cols }, (_, i) => (
            <circle key={i} cx={(i % cols) + 0.5} cy={Math.floor(i / cols) + 0.5} r={0.05} fill="#cbd5e1" />
          ))}

          {arrows.map((a, idx) => {
            const info = pathInfo(a)
            const [dr, dc] = DELTA[a.dir]
            const head = a.cells[a.cells.length - 1]
            const wrong = shaking === a.id
            return (
              <g
                key={a.id}
                className={`arrow ${wrong ? 'arrow-shake' : 'arrow-in'}`}
                style={{ animationDelay: `${Math.min(idx * 4, 500)}ms` }}
              >
                {/* body: a dash the length of the trail, slid out along the full path on escape */}
                <polyline
                  className="arrow-body"
                  points={info.full}
                  fill="none"
                  stroke={wrong ? '#ef4444' : '#1f2937'}
                  strokeWidth={0.12}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${info.dashLen} ${info.fullLen}`}
                  strokeDashoffset={a.gone ? -info.fullLen : 0}
                  style={{ transition: 'stroke-dashoffset 500ms ease-in' }}
                />
                {/* arrowhead: a stub at the head carrying the marker, sliding straight out with the front */}
                <g
                  style={{
                    transform: a.gone ? `translate(${dc * info.exitLen}px, ${dr * info.exitLen}px)` : undefined,
                    transition: 'transform 500ms ease-in',
                  }}
                >
                  <line
                    x1={head.c + 0.5 - dc * 0.01}
                    y1={head.r + 0.5 - dr * 0.01}
                    x2={head.c + 0.5}
                    y2={head.r + 0.5}
                    stroke="none"
                    markerEnd={wrong ? 'url(#headRed)' : 'url(#head)'}
                  />
                </g>
                {/* hit area over the resting trail */}
                <polyline
                  points={info.trail}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={0.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="cursor-pointer"
                  style={{ pointerEvents: a.gone ? 'none' : 'stroke' }}
                  onClick={() => tap(a.id)}
                />
              </g>
            )
          })}
            </svg>
          </div>
        </div>

        {(view.s !== 1 || view.x !== 0 || view.y !== 0) && (
          <button
            onClick={() => {
              viewRef.current = { s: 1, x: 0, y: 0 }
              setView(viewRef.current)
            }}
            className="fade-in absolute right-3 bottom-3 z-10 rounded-full bg-white/90 px-3 py-1.5 text-xs font-bold text-slate-600 shadow ring-1 ring-slate-200 backdrop-blur transition active:scale-90"
          >
            Recenter
          </button>
        )}

        {status !== 'playing' && (
          <div className="fade-in absolute inset-0 z-20 grid place-items-center rounded-2xl bg-black/50">
            <div className="pop-in flex flex-col items-center gap-3 rounded-2xl bg-white px-10 py-8 text-center shadow-2xl">
              <div className="text-5xl">{status === 'won' ? '🎉' : '💔'}</div>
              <p className="text-xl font-bold text-slate-800">
                {status === 'won' ? `Level ${level} clear!` : 'Out of hearts'}
              </p>
              <button
                onClick={() => startLevel(status === 'won' ? Math.min(level + 1, LEVEL_COUNT) : level)}
                className="mt-1 rounded-full bg-blue-500 px-8 py-3 font-bold text-white shadow transition hover:bg-blue-600 active:scale-95"
              >
                {status === 'won' ? 'Next Level' : 'Try Again'}
              </button>
            </div>
          </div>
        )}
      </div>

      {level === 1 && status === 'playing' && (
        <p className="float-y relative z-10 -mt-1 text-sm font-medium text-slate-400">Tap an arrow to slide it out ✦</p>
      )}

      {status === 'won' && <Confetti />}

      <div className="relative z-10 mt-auto w-full bg-slate-50 pt-2 text-center text-3xl font-black tracking-tight text-slate-800">
        Arrows Escape
      </div>

      {showLevels && (
        <div className="fade-in fixed inset-0 z-50 flex flex-col bg-slate-50 px-6 py-8">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-800">Select Level</h2>
            <button
              onClick={() => setShowLevels(false)}
              className="grid size-11 place-items-center rounded-full bg-blue-500 text-white shadow transition active:scale-90"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
          <p className="mb-5 text-sm text-slate-400">Reached level {maxLevel}</p>
          <div className="grid grid-cols-5 gap-3 overflow-auto pb-4">
            {Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1).map((n) => {
              const locked = n > maxLevel
              const current = n === level
              return (
                <button
                  key={n}
                  disabled={locked}
                  onClick={() => {
                    startLevel(n)
                    setShowLevels(false)
                  }}
                  className={`grid aspect-square place-items-center rounded-xl text-lg font-bold shadow-sm transition active:scale-90 ${
                    current
                      ? 'bg-blue-500 text-white ring-2 ring-blue-300'
                      : locked
                        ? 'bg-slate-100 text-slate-300'
                        : 'bg-white text-slate-700 hover:bg-blue-50'
                  }`}
                >
                  {locked ? <LockIcon /> : n}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
