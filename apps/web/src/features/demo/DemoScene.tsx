/**
 * react-three-fiber scene for the station-flip demo.
 * Yaskawa millimetres, Z-up (root group rotates into Three.js Y-up).
 */

import { Canvas } from "@react-three/fiber"
import { Grid, Line, OrbitControls } from "@react-three/drei"
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
const FIXTURE = "#a1a1aa"
const MIRROR = "#f59e0b"

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
          <sphereGeometry args={[active ? 18 : 10, 16, 16]} />
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

const FixturePlane = ({
  buser,
  layout,
  side
}: {
  buser: CartesianPose
  layout: DemoLayoutMode
  side: "source" | "target"
}) => {
  const transform = useMemo(() => {
    if (layout === "sideBySide") {
      return {
        position: new THREE.Vector3(0, 0, 0),
        quaternion: new THREE.Quaternion()
      }
    }
    return poseToObject3d(buser)
  }, [buser, layout])

  const accent = side === "source" ? PATH_SOURCE : PATH_FLIPPED

  return (
    <group position={transform.position} quaternion={transform.quaternion}>
      <mesh position={[300, 0, -3]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[700, 420]} />
        <meshStandardMaterial color={FIXTURE} transparent opacity={0.32} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0, 20]}>
        <boxGeometry args={[48, 48, 40]} />
        <meshStandardMaterial color={accent} />
      </mesh>
      <mesh position={[650, 0, 15]}>
        <boxGeometry args={[40, 180, 30]} />
        <meshStandardMaterial color={accent} transparent opacity={0.55} />
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
    // Plane at local x = Lx/2 in source UF (YZ plane), expressed in base
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
      <meshStandardMaterial color={MIRROR} transparent opacity={0.2} side={THREE.DoubleSide} />
    </mesh>
  )
}

const RobotBase = () => (
  <group>
    <mesh position={[0, 0, 40]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[120, 140, 80, 6]} />
      <meshStandardMaterial color="#2563eb" />
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

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[800, -600, 1200]} intensity={1.1} />
      <directionalLight position={[-500, 400, 800]} intensity={0.45} />
      <RobotBase />
      <FixturePlane buser={model.sourceFrame.buser} layout={layout} side="source" />
      {layout === "overlay" ? (
        <FixturePlane buser={model.targetFrame.buser} layout={layout} side="target" />
      ) : null}
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
          <sphereGeometry args={[24, 16, 16]} />
          <meshStandardMaterial color="#93c5fd" wireframe />
        </mesh>
      ) : null}
      {s2 ? (
        <mesh position={s2.position}>
          <sphereGeometry args={[24, 16, 16]} />
          <meshStandardMaterial color={s2.failed ? PATH_FAIL : "#86efac"} wireframe />
        </mesh>
      ) : null}
      <Grid
        args={[4000, 4000]}
        cellSize={100}
        cellThickness={0.55}
        sectionSize={500}
        sectionThickness={1.1}
        sectionColor="#3a404a"
        cellColor="#2c3038"
        fadeDistance={3500}
        infiniteGrid
        position={[0, 0, -6]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <OrbitControls makeDefault target={[750, 0, 150]} />
    </>
  )
}

export const DemoCanvas = (props: DemoSceneProps) => (
  <div className="h-full min-h-[420px] w-full overflow-hidden rounded border border-border bg-bg">
    <Canvas
      camera={{ position: [1900, -1700, 1200], fov: 42, near: 1, far: 20000 }}
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
