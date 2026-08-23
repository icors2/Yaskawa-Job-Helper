import flipAssistImage from "../../assets/flip-assist.png"
import flipAssistLeftImage from "../../assets/flip-assist-left.png"
import flipAssistRightImage from "../../assets/flip-assist-right.png"
import type { MirrorPlane } from "../../lib/kin/client"
import type { StationSide } from "../../lib/jbi/frameTransform"

export type TransformDemoMode = "mirror" | "transfer" | "offset" | "singleSide" | "frameFlip"

interface FlipAssistDemoProps {
  mode: TransformDemoMode
  mirrorPlane: MirrorPlane
  sourceUf: number
  targetUf: number
  stationSide?: StationSide
}

/** Dual-station flip-assist.png — keep SVG viewBox in sync. */
const DUAL_W = 884
const DUAL_H = 557

/** Single-station left/right PNGs (450×557). */
const SINGLE_W = 450
const SINGLE_H = 557

/**
 * XYZ userframe origins on each tabletop (pink junction where orange X, green Y,
 * and purple Z meet), sampled from flip-assist.png.
 */
const LEFT_TABLE = { cx: 209, cy: 237 }
const RIGHT_TABLE = { cx: 647, cy: 242 }

/**
 * Origin anchors on single-side PNGs (measured from Assets/Flip assist left|right.png).
 * Center demo parts on the pink XYZ junction.
 */
const SINGLE_LEFT_ORIGIN = { cx: 235, cy: 240 }
const SINGLE_RIGHT_ORIGIN = { cx: 214, cy: 241 }

/** Scale of demo part / weld path in table-local space. */
const PART_SCALE = 2.35

const SOURCE_PATH = "M -38 8 L -12 -10 L 10 -4 L 28 12 L 18 28"
const SOURCE_PART =
  "M -48 -18 L 42 -18 L 42 6 L 4 6 L 4 36 L -48 36 Z"

const flipAssistCaption = (
  mode: TransformDemoMode,
  mirrorPlane: MirrorPlane,
  sourceUf: number,
  targetUf: number,
  stationSide: StationSide
): string => {
  if (mode === "singleSide") {
    const sideLabel = stationSide === "left" ? "Left" : "Right"
    return `Single-side mirror (${sideLabel}): before → after on the same station / same ///USER ${sourceUf}. Plane ${mirrorPlane} (default YZ = X flip). Review RCONF on the pendant.`
  }
  if (mode === "transfer") {
    return `Transfer (identical fixtures): demo part stays in the same seat on both tabletops — only ///USER ${sourceUf} → ${targetUf} changes.`
  }
  if (mode === "frameFlip") {
    return `Frame convert (Flip): remaps cartesian path from UF${sourceUf} BUSER into UF${targetUf} via inv(UF_new)@UF_old@P — not a simple ///USER relabel.`
  }
  if (mode === "offset") {
    return "Offset: small cartesian shift of the demo part/path on the fixture (right station shows the delta)."
  }
  if (mirrorPlane === "XY") {
    return "Mirror XY: reflection across the table plane (Z flips). Path height inverts through the fixture — review RCONF on the pendant."
  }
  if (mirrorPlane === "YZ") {
    return "Mirror YZ: reflection across the station YZ plane (X flips). Path swaps along the fixture X axis on the opposite table."
  }
  return "Mirror XZ: reflection across the station XZ plane (Y flips). Path swaps across the fixture Y axis onto the opposite table."
}

const tableSkew = (cx: number, cy: number, extra = ""): string =>
  `translate(${cx} ${cy}) matrix(1 0.1 -0.42 0.52 0 0)${extra ? ` ${extra}` : ""}`

const PartBody = ({
  fill,
  stroke,
  pathStroke,
  pathDash
}: {
  fill: string
  stroke: string
  pathStroke: string
  pathDash?: string
}) => (
  <g transform={`scale(${PART_SCALE})`}>
    <path
      d={SOURCE_PART}
      fill={fill}
      fillOpacity={0.88}
      stroke={stroke}
      strokeWidth={2.2}
      strokeLinejoin="round"
    />
    <path
      d={SOURCE_PATH}
      fill="none"
      stroke={pathStroke}
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={pathDash}
      opacity={0.95}
    />
    <circle cx={-38} cy={8} r={4.2} fill={pathStroke} />
  </g>
)

const PlaneCue = ({ plane }: { plane: MirrorPlane }) => {
  if (plane === "XY") {
    return (
      <g opacity={0.85} transform={`scale(${PART_SCALE})`}>
        <ellipse
          cx={0}
          cy={0}
          rx={58}
          ry={22}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={1.8}
          strokeDasharray="7 5"
        />
        <text x={-52} y={-38} fill="#94a3b8" fontSize={11} fontWeight={600}>
          XY plane
        </text>
      </g>
    )
  }
  if (plane === "YZ") {
    return (
      <g opacity={0.85} transform={`scale(${PART_SCALE})`}>
        <line
          x1={0}
          y1={-48}
          x2={0}
          y2={48}
          stroke="#94a3b8"
          strokeWidth={1.8}
          strokeDasharray="6 5"
        />
        <text x={10} y={-42} fill="#94a3b8" fontSize={11} fontWeight={600}>
          YZ
        </text>
      </g>
    )
  }
  return (
    <g opacity={0.85} transform={`scale(${PART_SCALE})`}>
      <line
        x1={-55}
        y1={0}
        x2={55}
        y2={0}
        stroke="#94a3b8"
        strokeWidth={1.8}
        strokeDasharray="6 5"
      />
      <text x={-22} y={-16} fill="#94a3b8" fontSize={11} fontWeight={600}>
        XZ
      </text>
    </g>
  )
}

const mirrorScale = (plane: MirrorPlane): string => {
  if (plane === "YZ") {
    return "scale(-1 1)"
  }
  if (plane === "XZ") {
    return "scale(1 -1)"
  }
  return "scale(1 1)"
}

const MirrorTarget = ({ plane }: { plane: MirrorPlane }) => {
  const label =
    plane === "XY"
      ? "Z-flipped path"
      : plane === "YZ"
        ? "X-flipped path"
        : "Y-flipped path"

  if (plane === "XY") {
    return (
      <g>
        <g transform="scale(1 -1)" opacity={0.3}>
          <PartBody
            fill="#1e293b"
            stroke="#64748b"
            pathStroke="#2a9d8f"
            pathDash="8 5"
          />
        </g>
        <g transform="translate(0 -8)">
          <PartBody
            fill="#0f766e"
            stroke="#2a9d8f"
            pathStroke="#5eead4"
            pathDash="8 5"
          />
        </g>
        <path
          d="M 0 78 L 0 108"
          stroke="#c8102e"
          strokeWidth={3}
          markerEnd="url(#flipArrow)"
        />
        <text x={14} y={118} fill="#c8102e" fontSize={18} fontWeight={600}>
          Z ↔ −Z
        </text>
        <text x={-88} y={142} fill="#5eead4" fontSize={20} fontWeight={600}>
          {label}
        </text>
        <PlaneCue plane="XY" />
      </g>
    )
  }

  return (
    <g>
      <g transform={mirrorScale(plane)}>
        <PartBody
          fill="#0f766e"
          stroke="#2a9d8f"
          pathStroke="#5eead4"
          pathDash="8 5"
        />
      </g>
      <PlaneCue plane={plane} />
      <text x={-88} y={128} fill="#5eead4" fontSize={20} fontWeight={600}>
        {label}
      </text>
    </g>
  )
}

/** Before → after on one station (same UF), for single-side mirror. */
const SingleSideOverlay = ({
  plane,
  origin,
  side
}: {
  plane: MirrorPlane
  origin: { cx: number; cy: number }
  side: StationSide
}) => {
  const beforeShift =
    plane === "YZ" ? "translate(-52 0)" : plane === "XZ" ? "translate(0 36)" : "translate(-28 24)"
  const afterShift =
    plane === "YZ" ? "translate(52 0)" : plane === "XZ" ? "translate(0 -36)" : "translate(28 -24)"

  return (
    <g>
      <text x={16} y={36} fill="#64748b" fontSize={16} fontWeight={700}>
        {side === "left" ? "Left station" : "Right station"} · same ///USER
      </text>
      <g transform={tableSkew(origin.cx, origin.cy, beforeShift)}>
        <PartBody fill="#1e293b" stroke="#94a3b8" pathStroke="#e85d04" />
        <text x={-70} y={118} fill="#e85d04" fontSize={16} fontWeight={600}>
          Before
        </text>
      </g>
      <g transform={tableSkew(origin.cx, origin.cy)}>
        <PlaneCue plane={plane} />
      </g>
      <g transform={tableSkew(origin.cx, origin.cy, afterShift)}>
        <g transform={mirrorScale(plane)}>
          <PartBody
            fill="#0f766e"
            stroke="#2a9d8f"
            pathStroke="#5eead4"
            pathDash="8 5"
          />
        </g>
        <text x={-60} y={118} fill="#5eead4" fontSize={16} fontWeight={600}>
          After
        </text>
      </g>
      <path
        d={
          plane === "YZ"
            ? `M ${origin.cx - 20} ${origin.cy - 8} L ${origin.cx + 20} ${origin.cy - 8}`
            : plane === "XZ"
              ? `M ${origin.cx + 8} ${origin.cy + 20} L ${origin.cx + 8} ${origin.cy - 20}`
              : `M ${origin.cx - 16} ${origin.cy + 12} L ${origin.cx + 16} ${origin.cy - 12}`
        }
        fill="none"
        stroke="#c8102e"
        strokeWidth={2.5}
        markerEnd="url(#flipArrow)"
        opacity={0.9}
      />
      <text
        x={origin.cx - 48}
        y={origin.cy + 150}
        fill="#94a3b8"
        fontSize={14}
        fontWeight={600}
      >
        Mirror {plane} · same frame
      </text>
    </g>
  )
}

export const FlipAssistDemo = ({
  mode,
  mirrorPlane,
  sourceUf,
  targetUf,
  stationSide = "left"
}: FlipAssistDemoProps) => {
  const caption = flipAssistCaption(mode, mirrorPlane, sourceUf, targetUf, stationSide)
  const showMirror = mode === "mirror"
  const showTransfer = mode === "transfer" || mode === "frameFlip"
  const showOffset = mode === "offset"
  const showSingleSide = mode === "singleSide"

  if (showSingleSide) {
    const image = stationSide === "left" ? flipAssistLeftImage : flipAssistRightImage
    const origin = stationSide === "left" ? SINGLE_LEFT_ORIGIN : SINGLE_RIGHT_ORIGIN
    const alt =
      stationSide === "left"
        ? "Flip assist left station with XYZ userframe origin"
        : "Flip assist right station with XYZ userframe origin"

    return (
      <figure className="rounded border border-border bg-surface/40">
        <div className="bg-bg/80 p-2 sm:p-4">
          <div className="relative mx-auto w-full max-w-3xl min-h-[22rem]">
            <img
              src={image}
              alt={alt}
              className="block h-auto w-full object-contain"
              width={SINGLE_W}
              height={SINGLE_H}
            />
            <svg
              key={`demo-single-${stationSide}-${mirrorPlane}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox={`0 0 ${SINGLE_W} ${SINGLE_H}`}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="flipArrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="6"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="#c8102e" />
                </marker>
              </defs>
              <SingleSideOverlay plane={mirrorPlane} origin={origin} side={stationSide} />
            </svg>
          </div>
        </div>
        <figcaption className="border-t border-border px-3 py-2 text-sm text-muted">
          {caption}
        </figcaption>
      </figure>
    )
  }

  return (
    <figure className="rounded border border-border bg-surface/40">
      <div className="bg-bg/80 p-2 sm:p-4">
        <div className="relative mx-auto w-full max-w-7xl min-h-[22rem]">
          <img
            src={flipAssistImage}
            alt="Flip assist diagram showing left and right userframe stations beside the robot"
            className="block h-auto w-full object-contain"
            width={DUAL_W}
            height={DUAL_H}
          />
          <svg
            key={`demo-${mode}-${mirrorPlane}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${DUAL_W} ${DUAL_H}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="flipArrow"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill="#c8102e" />
              </marker>
              <marker
                id="transferArrow"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill="#f4a261" />
              </marker>
            </defs>

            <text x={42} y={168} fill="#64748b" fontSize={18} fontWeight={700}>
              Left station
            </text>
            <text x={702} y={168} fill="#64748b" fontSize={18} fontWeight={700}>
              Right station
            </text>

            <g transform={tableSkew(LEFT_TABLE.cx, LEFT_TABLE.cy)}>
              <PartBody fill="#1e293b" stroke="#94a3b8" pathStroke="#e85d04" />
              <text x={-96} y={128} fill="#e85d04" fontSize={20} fontWeight={600}>
                Source path
              </text>
              {showMirror ? <PlaneCue plane={mirrorPlane} /> : null}
            </g>

            {showMirror ? (
              <g transform={tableSkew(RIGHT_TABLE.cx, RIGHT_TABLE.cy)}>
                <MirrorTarget plane={mirrorPlane} />
              </g>
            ) : null}

            {showTransfer ? (
              <>
                <g transform={tableSkew(RIGHT_TABLE.cx, RIGHT_TABLE.cy)}>
                  <PartBody fill="#1e293b" stroke="#94a3b8" pathStroke="#2a9d8f" />
                  <text x={-96} y={128} fill="#2a9d8f" fontSize={20} fontWeight={600}>
                    Same relative seat
                  </text>
                </g>
                <path
                  d="M 300 200 C 400 160, 490 160, 590 200"
                  fill="none"
                  stroke="#f4a261"
                  strokeWidth={3}
                  markerEnd="url(#transferArrow)"
                  opacity={0.9}
                />
                <text x={370} y={168} fill="#f4a261" fontSize={18} fontWeight={700}>
                  ///USER {sourceUf} → {targetUf}
                </text>
              </>
            ) : null}

            {showOffset ? (
              <>
                <g opacity={0.4} transform={tableSkew(RIGHT_TABLE.cx, RIGHT_TABLE.cy)}>
                  <g transform={`scale(${PART_SCALE})`}>
                    <path
                      d={SOURCE_PART}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                    />
                  </g>
                </g>
                <g transform={tableSkew(RIGHT_TABLE.cx, RIGHT_TABLE.cy, "translate(28 -18)")}>
                  <PartBody
                    fill="#334155"
                    stroke="#c9a227"
                    pathStroke="#c9a227"
                    pathDash="6 4"
                  />
                  <text x={-96} y={128} fill="#c9a227" fontSize={20} fontWeight={600}>
                    Offset path
                  </text>
                </g>
                <path
                  d="M 647 242 L 710 208"
                  fill="none"
                  stroke="#c9a227"
                  strokeWidth={3}
                  markerEnd="url(#transferArrow)"
                />
                <text x={716} y={202} fill="#c9a227" fontSize={18} fontWeight={600}>
                  Δxyz
                </text>
              </>
            ) : null}

            {showMirror ? (
              <>
                <line
                  x1={DUAL_W / 2}
                  y1={140}
                  x2={DUAL_W / 2}
                  y2={470}
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  strokeDasharray="5 7"
                  opacity={0.55}
                />
                <text x={DUAL_W / 2 - 58} y={132} fill="#94a3b8" fontSize={16} fontWeight={600}>
                  Mirror {mirrorPlane}
                </text>
              </>
            ) : null}
          </svg>
        </div>
      </div>
      <figcaption className="border-t border-border px-3 py-2 text-sm text-muted">
        {caption}
      </figcaption>
    </figure>
  )
}
