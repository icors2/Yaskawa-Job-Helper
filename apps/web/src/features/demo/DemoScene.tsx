/**
 * react-three-fiber scene for the station-flip demo.
 * Yaskawa millimetres, Z-up (root group rotates into Three.js Y-up).
 * Overlay layout matches Cell Render: robot at origin, UF2/UF3 tabletops from BUSER.
 */

import { Canvas } from "@react-three/fiber"
import { Grid, Line, OrbitControls, Text } from "@react-three/drei"
import { useMemo } from "react"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"
import { composePoses, poseToMatrix } from "@yaskawa/core/kin/pose"
import type { CartesianPose } from "@yaskawa/core/kin/types"
import type { DemoLayoutMode, DemoModel, DemoPoint } from "./demoModel"
import { sampleTriadIndices } from "./demoModel"

interface DemoSceneProps {
  model: DemoModel
  layout: DemoLayoutMode
  scrubIndex: number
  showTriads: boolean
  showMirrorPlane: boolean
  onSelectPoint: (index: number) => void
}

const PATH_SOURCE = "#3b82f6"
const PATH_FLIPPED = "#22c55e"
const PATH_FAIL = "#e11d48"
const TABLE_TOP = "#f4f4f5"
const TABLE_LEG = "#d4d4d8"
const PART = "#e4e4e7"
const MIRROR = "#f59e0b"
const ROBOT = "#2563eb"

/** Table spans local X across the mirror width so the path sits on the deck. */
const TABLE_LENGTH = 1400
const TABLE_WIDTH = 520
const TABLE_THICKNESS = 18
const LEG_HEIGHT = 320
const LEG_SIZE = 55

const poseToObject3d = (pose: CartesianPose) => {
  const m = poseToMatrix(pose)
  const mat = new THREE.Matrix4().set(
    m[0][0],
    m[0][1],
    m[0][2],
    m[0][3],
    m[1][0],
    m[1][1],
    m[1][2],
    m[1][3],
    m[2][0],
    m[2][1],
    m[2][2],
    m[2][3],
    0,
    0,
    0,
    1
  )
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  mat.decompose(position, quaternion, scale)
  return { position, quaternion }
}

const toLinePoints = (points: DemoPoint[]): [number, number, number][] =>
  points.map((point) => point.position)

const Triad = ({ point }: { point: DemoPoint }) => {
  const o = point.position
  const tip = (axis: [number, number, number]): [number, number, number] => [
    o[0] + axis[0],
    o[1] + axis[1],
    o[2] + axis[2]
  ]
  return (
    <group>
      <Line points={[o, tip(point.axes.x)]} color="#ef4444" lineWidth={2} />
      <Line points={[o, tip(point.axes.y)]} color="#22c55e" lineWidth={2} />
      <Line points={[o, tip(point.axes.z)]} color="#3b82f6" lineWidth={2} />
    </group>
  )
}

const PathMarkers = ({
  points,
  scrubIndex,
  color,
  failColor,
  onSelectPoint
}: {
  points: DemoPoint[]
  scrubIndex: number
  color: string
  failColor: string
  onSelectPoint: (index: number) => void
}) => (
  <group>
    {points.map((point) => {
      const active = point.index === scrubIndex
      const fill = point.failed ? failColor : color
      const handleClick = (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        onSelectPoint(point.index)
      }
      return (
        <mesh
          key={`${point.index}-${fill}`}
          position={point.position}
          onClick={handleClick}
          onPointerOver={() => {
            document.body.style.cursor = "pointer"
          }}
          onPointerOut={() => {
            document.body.style.cursor = "auto"
          }}
        >
          <sphereGeometry args={[active ? 16 : 9, 16, 16]} />
          <meshStandardMaterial
            color={fill}
            emissive={active ? fill : "#000000"}
            emissiveIntensity={active ? 0.35 : 0}
          />
        </mesh>
      )
    })}
  </group>
)

const TPart = ({ accent }: { accent: string }) => (
  <group position={[0, 0, TABLE_THICKNESS / 2 + 28]}>
    <mesh position={[0, 0, 0]}>
      <boxGeometry args={[220, 70, 40]} />
      <meshStandardMaterial color={PART} />
    </mesh>
    <mesh position={[0, -90, 0]}>
      <boxGeometry args={[70, 140, 40]} />
      <meshStandardMaterial color={PART} />
    </mesh>
    <mesh position={[0, 0, 24]}>
      <boxGeometry args={[40, 40, 8]} />
      <meshStandardMaterial color={accent} />
    </mesh>
  </group>
)

const StationTable = ({
  buser,
  layout,
  side,
  label,
  lx,
  sideOffsetY
}: {
  buser: CartesianPose
  layout: DemoLayoutMode
  side: "source" | "target"
  label: string
  lx: number
  /** Local Y shift used only in side-by-side so both decks are visible. */
  sideOffsetY: number
}) => {
  const transform = useMemo(() => {
    if (layout === "sideBySide") {
      return {
        position: new THREE.Vector3(0, sideOffsetY, 0),
        quaternion: new THREE.Quaternion()
      }
    }
    return poseToObject3d(buser)
  }, [buser, layout, sideOffsetY])

  const accent = side === "source" ? PATH_SOURCE : PATH_FLIPPED
  const tableCenterX = lx / 2
  const halfLen = TABLE_LENGTH / 2
  const halfWid = TABLE_WIDTH / 2
  const legZ = -LEG_HEIGHT / 2 - TABLE_THICKNESS / 2
  const legOffsets: [number, number][] = [
    [-halfLen + 80, -halfWid + 60],
    [halfLen - 80, -halfWid + 60],
    [-halfLen + 80, halfWid - 60],
    [halfLen - 80, halfWid - 60]
  ]

  return (
    <group position={transform.position} quaternion={transform.quaternion}>
      <group position={[tableCenterX, 0, 0]}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[TABLE_LENGTH, TABLE_WIDTH, TABLE_THICKNESS]} />
          <meshStandardMaterial color={TABLE_TOP} metalness={0.05} roughness={0.75} />
        </mesh>
        {legOffsets.map(([lxOff, lyOff]) => (
          <mesh key={`${lxOff}-${lyOff}`} position={[lxOff, lyOff, legZ]}>
            <boxGeometry args={[LEG_SIZE, LEG_SIZE, LEG_HEIGHT]} />
            <meshStandardMaterial color={TABLE_LEG} roughness={0.85} />
          </mesh>
        ))}
        <TPart accent={accent} />
        <Text
          position={[0, 0, TABLE_THICKNESS / 2 + 2]}
          rotation={[-Math.PI / 2, 0, Math.PI / 2]}
          fontSize={64}
          color={accent}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#18181b"
        >
          {label}
        </Text>
      </group>
      {/* UF origin marker */}
      <mesh position={[0, 0, 12]}>
        <boxGeometry args={[36, 36, 24]} />
        <meshStandardMaterial color={accent} />
      </mesh>
    </group>
  )
}

const MirrorPlaneViz = ({
  model,
  layout
}: {
  model: DemoModel
  layout: DemoLayoutMode
}) => {
  const half = model.lx / 2

  const transform = useMemo(() => {
    if (layout === "sideBySide") {
      return {
        position: new THREE.Vector3(half, 0, 200),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
      }
    }
    const local: CartesianPose = {
      x: half,
      y: 0,
      z: 200,
      rx: 0,
      ry: 90,
      rz: 0
    }
    return poseToObject3d(composePoses(model.sourceFrame.buser, local))
  }, [layout, half, model.sourceFrame.buser])

  return (
    <mesh position={transform.position} quaternion={transform.quaternion}>
      <planeGeometry args={[900, 520]} />
      <meshStandardMaterial color={MIRROR} transparent opacity={0.18} side={THREE.DoubleSide} />
    </mesh>
  )
}

const RobotBase = () => (
  <group>
    <mesh position={[0, 0, 280]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[110, 130, 560, 6]} />
      <meshStandardMaterial color={ROBOT} metalness={0.15} roughness={0.55} />
    </mesh>
    <mesh position={[0, 0, 8]}>
      <cylinderGeometry args={[160, 160, 16, 6]} />
      <meshStandardMaterial color="#1d4ed8" />
    </mesh>
    <axesHelper args={[280]} />
  </group>
)

const SceneContent = ({
  model,
  layout,
  scrubIndex,
  showTriads,
  showMirrorPlane,
  onSelectPoint
}: DemoSceneProps) => {
  const triadIdx = useMemo(
    () => sampleTriadIndices(model.pointCount, scrubIndex),
    [model.pointCount, scrubIndex]
  )

  const sourceTriads = triadIdx
    .map((index) => model.sourcePoints[index])
    .filter(Boolean) as DemoPoint[]
  const flippedTriads = triadIdx
    .map((index) => model.flippedPoints[index])
    .filter(Boolean) as DemoPoint[]

  const s1 = model.sourcePoints[scrubIndex]
  const s2 = model.flippedPoints[scrubIndex]

  const lookTarget = useMemo((): [number, number, number] => {
    if (layout === "sideBySide") {
      return [model.lx / 2, 0, 120]
    }
    const pts = [...model.sourcePoints, ...model.flippedPoints]
    if (!pts.length) {
      return [700, 0, 100]
    }
    const xs = pts.map((p) => p.position[0])
    const ys = pts.map((p) => p.position[1])
    const zs = pts.map((p) => p.position[2])
    return [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
      Math.min(180, (Math.min(...zs) + Math.max(...zs)) / 2)
    ]
  }, [layout, model])

  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[600, -900, 1400]} intensity={1.15} castShadow />
      <directionalLight position={[-700, 500, 900]} intensity={0.4} />
      <RobotBase />
      <StationTable
        buser={model.sourceFrame.buser}
        layout={layout}
        side="source"
        label="UserFrame 2"
        lx={model.lx}
        sideOffsetY={layout === "sideBySide" ? -420 : 0}
      />
      <StationTable
        buser={model.targetFrame.buser}
        layout={layout}
        side="target"
        label="UserFrame 3"
        lx={model.lx}
        sideOffsetY={layout === "sideBySide" ? 420 : 0}
      />
      {showMirrorPlane ? <MirrorPlaneViz model={model} layout={layout} /> : null}
      {model.sourcePoints.length >= 2 ? (
        <Line points={toLinePoints(model.sourcePoints)} color={PATH_SOURCE} lineWidth={2.5} />
      ) : null}
      {model.flippedPoints.length >= 2 ? (
        <Line points={toLinePoints(model.flippedPoints)} color={PATH_FLIPPED} lineWidth={2.5} />
      ) : null}
      <PathMarkers
        points={model.sourcePoints}
        scrubIndex={scrubIndex}
        color={PATH_SOURCE}
        failColor={PATH_FAIL}
        onSelectPoint={onSelectPoint}
      />
      <PathMarkers
        points={model.flippedPoints}
        scrubIndex={scrubIndex}
        color={PATH_FLIPPED}
        failColor={PATH_FAIL}
        onSelectPoint={onSelectPoint}
      />
      {showTriads
        ? [...sourceTriads, ...flippedTriads].map((point) => (
            <Triad key={`triad-${point.index}-${point.failed ? "f" : "ok"}`} point={point} />
          ))
        : null}
      {s1 ? (
        <mesh position={s1.position}>
          <sphereGeometry args={[22, 16, 16]} />
          <meshStandardMaterial color="#93c5fd" wireframe />
        </mesh>
      ) : null}
      {s2 ? (
        <mesh position={s2.position}>
          <sphereGeometry args={[22, 16, 16]} />
          <meshStandardMaterial color={s2.failed ? PATH_FAIL : "#86efac"} wireframe />
        </mesh>
      ) : null}
      <Grid
        args={[5000, 5000]}
        cellSize={100}
        cellThickness={0.5}
        sectionSize={500}
        sectionThickness={1.05}
        sectionColor="#3a404a"
        cellColor="#2c3038"
        fadeDistance={4200}
        infiniteGrid
        position={[0, 0, -6]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <OrbitControls makeDefault target={lookTarget} />
    </>
  )
}

export const DemoCanvas = (props: DemoSceneProps) => {
  const cameraPos = useMemo((): [number, number, number] => {
    if (props.layout === "sideBySide") {
      return [1600, -1400, 1100]
    }
    // Behind the robot looking toward +X stations (Cell Render vantage).
    return [-400, -2200, 1600]
  }, [props.layout])

  return (
    <div className="h-full min-h-[420px] w-full overflow-hidden rounded border border-border bg-bg">
      <Canvas
        key={props.layout}
        camera={{ position: cameraPos, fov: 40, near: 1, far: 25000 }}
        gl={{ antialias: true }}
        dpr={[1, 1.75]}
        aria-label="Station flip 3D visualization"
      >
        <color attach="background" args={["#0b0c0f"]} />
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <SceneContent {...props} />
        </group>
      </Canvas>
    </div>
  )
}
