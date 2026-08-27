"""Data-driven station mirror flip (S1 ↔ S2).

Physical model, in station user-frame coordinates:

    x' = Lx - x,  y' = y,  z' = z
    R' = diag(-1, 1, 1) @ R @ diag(1, -1, 1)

``Lx`` and the tool-side correction vary by fixture family, so they are
fitted from a known-good pulse pair (SVD / Umeyama with reflection
allowed, then robust inlier rejection at 3× median residual).

Pairs that fit a proper rotation (det(R) > 0) are transfer / same-UF
artifacts and are rejected. Fits with fewer than 60 % inliers are also
rejected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from numpy.typing import NDArray

from ar2010 import (
    AR2010Params,
    HOME_PULSES,
    Pose,
    compose_poses,
    default_params,
    default_tool,
    forward_kinematics,
    matrix_to_pose,
    pose_to_matrix,
    relative_pose,
    rotation_geodesic_deg,
)
from ik import IkResult, inverse_kinematics

Mat = NDArray[np.float64]
Vec = NDArray[np.float64]

MIRROR_X = np.diag([-1.0, 1.0, 1.0])
TOOL_Y_FLIP = np.diag([1.0, -1.0, 1.0])

INLIER_FRACTION_MIN = 0.60
RESIDUAL_MEDIAN_MULT = 3.0
MIN_FIT_POINTS = 3


@dataclass
class FlipRecipe:
    mirror_axis: str
    offset: tuple[float, float, float]
    mirror_matrix: Mat
    tool_correction: Mat
    position_rms_mm: float = 0.0
    orientation_rms_deg: float = 0.0
    inliers: int = 0
    total: int = 0
    det_r: float = -1.0
    source_frame_id: int | None = None
    target_frame_id: int | None = None
    source_job_name: str = ""
    target_job_name: str = ""
    job_family: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "mirrorAxis": self.mirror_axis,
            "offset": [float(v) for v in self.offset],
            "mirrorMatrix": _mat3_to_list(self.mirror_matrix),
            "toolCorrection": _mat3_to_list(self.tool_correction),
            "positionRmsMm": float(self.position_rms_mm),
            "orientationRmsDeg": float(self.orientation_rms_deg),
            "inliers": int(self.inliers),
            "total": int(self.total),
            "detR": float(self.det_r),
            "sourceFrameId": self.source_frame_id,
            "targetFrameId": self.target_frame_id,
            "sourceJobName": self.source_job_name,
            "targetJobName": self.target_job_name,
            "jobFamily": self.job_family,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> FlipRecipe:
        offset_raw = data.get("offset") or [0.0, 0.0, 0.0]
        offset_vals = [float(v) for v in list(offset_raw)[:3]]  # type: ignore[arg-type]
        while len(offset_vals) < 3:
            offset_vals.append(0.0)
        mirror = _mat3_from_unknown(data.get("mirrorMatrix") or data.get("mirror_matrix"))
        if mirror is None:
            axis = str(data.get("mirrorAxis") or data.get("mirror_axis") or "X").upper()
            mirror = _axis_to_matrix(axis)
        tool = _mat3_from_unknown(data.get("toolCorrection") or data.get("tool_correction"))
        if tool is None:
            tool = TOOL_Y_FLIP.copy()
        return cls(
            mirror_axis=str(data.get("mirrorAxis") or data.get("mirror_axis") or _axis_from_matrix(mirror)),
            offset=(offset_vals[0], offset_vals[1], offset_vals[2]),
            mirror_matrix=mirror,
            tool_correction=tool,
            position_rms_mm=float(data.get("positionRmsMm") or data.get("position_rms_mm") or 0.0),
            orientation_rms_deg=float(
                data.get("orientationRmsDeg") or data.get("orientation_rms_deg") or 0.0
            ),
            inliers=int(data.get("inliers") or 0),
            total=int(data.get("total") or 0),
            det_r=float(data.get("detR") or data.get("det_r") or np.linalg.det(mirror)),
            source_frame_id=_optional_int(data.get("sourceFrameId") or data.get("source_frame_id")),
            target_frame_id=_optional_int(data.get("targetFrameId") or data.get("target_frame_id")),
            source_job_name=str(data.get("sourceJobName") or data.get("source_job_name") or ""),
            target_job_name=str(data.get("targetJobName") or data.get("target_job_name") or ""),
            job_family=str(data.get("jobFamily") or data.get("job_family") or ""),
        )


@dataclass
class FlipFitResult:
    accepted: bool
    message: str
    recipe: FlipRecipe | None
    position_rms_mm: float = 0.0
    orientation_rms_deg: float = 0.0
    inliers: int = 0
    total: int = 0
    det_r: float = 0.0
    inlier_indices: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "accepted": self.accepted,
            "message": self.message,
            "recipe": self.recipe.to_dict() if self.recipe is not None else None,
            "positionRmsMm": float(self.position_rms_mm),
            "orientationRmsDeg": float(self.orientation_rms_deg),
            "inliers": int(self.inliers),
            "total": int(self.total),
            "detR": float(self.det_r),
            "inlierIndices": [int(i) for i in self.inlier_indices],
        }


def recipe_from_lx(
    lx: float,
    ly: float = 0.0,
    lz: float = 0.0,
    *,
    source_frame_id: int | None = None,
    target_frame_id: int | None = None,
) -> FlipRecipe:
    """Closed-form X-axis station mirror used as the expected fit target."""
    return FlipRecipe(
        mirror_axis="X",
        offset=(float(lx), float(ly), float(lz)),
        mirror_matrix=MIRROR_X.copy(),
        tool_correction=TOOL_Y_FLIP.copy(),
        det_r=-1.0,
        source_frame_id=source_frame_id,
        target_frame_id=target_frame_id,
    )


def apply_flip(pose: Pose, recipe: FlipRecipe | dict) -> Pose:
    """Reflect one UF-relative pose with a fitted (or closed-form) recipe."""
    rec = recipe if isinstance(recipe, FlipRecipe) else FlipRecipe.from_dict(recipe)
    matrix = pose_to_matrix(pose)
    rotation = matrix[:3, :3]
    origin = matrix[:3, 3]
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = rec.mirror_matrix @ rotation @ rec.tool_correction
    out[:3, 3] = rec.mirror_matrix @ origin + np.asarray(rec.offset, dtype=np.float64)
    return matrix_to_pose(out)


def fit_flip(
    source_pulses: Sequence[Sequence[float]] | None = None,
    target_pulses: Sequence[Sequence[float]] | None = None,
    uf_source: Pose | None = None,
    uf_target: Pose | None = None,
    tool: Pose | None = None,
    params: AR2010Params | None = None,
    *,
    source_poses: Sequence[Pose] | None = None,
    target_poses: Sequence[Pose] | None = None,
    source_frame_id: int | None = None,
    target_frame_id: int | None = None,
    source_job_name: str = "",
    target_job_name: str = "",
    job_family: str = "",
) -> FlipFitResult:
    """FK both sides into their UFs, then fit a reflection-aware rigid map."""
    tcp = tool if tool is not None else default_tool()
    model = params or default_params()
    src_poses = list(source_poses) if source_poses is not None else []
    dst_poses = list(target_poses) if target_poses is not None else []
    if not src_poses:
        if not source_pulses:
            raise ValueError("fit_flip requires source_pulses or source_poses")
        if uf_source is None:
            raise ValueError("fit_flip requires uf_source when fitting from pulses")
        src_poses = _pulses_in_uf(source_pulses, uf_source, tcp, model)
    if not dst_poses:
        if not target_pulses:
            raise ValueError("fit_flip requires target_pulses or target_poses")
        if uf_target is None:
            raise ValueError("fit_flip requires uf_target when fitting from pulses")
        dst_poses = _pulses_in_uf(target_pulses, uf_target, tcp, model)

    count = min(len(src_poses), len(dst_poses))
    if count < MIN_FIT_POINTS:
        return FlipFitResult(
            accepted=False,
            message=(
                f"Need at least {MIN_FIT_POINTS} corresponding points to fit a station "
                f"mirror (got {count})."
            ),
            recipe=None,
            total=count,
        )

    src_xyz = np.array([[p.x, p.y, p.z] for p in src_poses[:count]], dtype=np.float64)
    dst_xyz = np.array([[p.x, p.y, p.z] for p in dst_poses[:count]], dtype=np.float64)
    src_rot = [pose_to_matrix(p)[:3, :3] for p in src_poses[:count]]
    dst_rot = [pose_to_matrix(p)[:3, :3] for p in dst_poses[:count]]

    rotation, translation, residuals, inlier_idx, threshold = _robust_umeyama(src_xyz, dst_xyz)
    det_r = float(np.linalg.det(rotation))
    n_in = int(inlier_idx.size)
    pos_rms = _rms(residuals[inlier_idx]) if n_in else _rms(residuals)

    if det_r > 0.0:
        return FlipFitResult(
            accepted=False,
            message=(
                f"Fit is a proper rotation (det(R)={det_r:+.3f}), not a reflection. "
                "This pair looks like a Transfer or same-UF artifact, not a station mirror."
            ),
            recipe=None,
            position_rms_mm=pos_rms,
            inliers=n_in,
            total=count,
            det_r=det_r,
            inlier_indices=[int(i) for i in inlier_idx],
        )

    if n_in < max(MIN_FIT_POINTS, int(np.ceil(INLIER_FRACTION_MIN * count))):
        return FlipFitResult(
            accepted=False,
            message=(
                f"Too few corresponding points ({n_in}/{count} inliers below "
                f"{threshold:.2f} mm). The pair may not be a re-taught S1/S2 mirror, "
                "or points are not in the same order."
            ),
            recipe=None,
            position_rms_mm=pos_rms,
            inliers=n_in,
            total=count,
            det_r=det_r,
            inlier_indices=[int(i) for i in inlier_idx],
        )

    tool_f = _fit_tool_correction(src_rot, dst_rot, rotation, inlier_idx)
    orient_errs = np.array(
        [
            rotation_geodesic_deg(rotation @ src_rot[int(i)] @ tool_f, dst_rot[int(i)])
            for i in inlier_idx
        ],
        dtype=np.float64,
    )
    # Position inliers already dropped non-corresponding points. Orientation
    # RMS uses the same 3×-median rule with an 8° floor so torch-angle scatter
    # is kept but ~180° wrong-convention / mismatched points are not.
    ori_mask, _ori_thr = _inlier_mask(orient_errs, min_threshold=8.0)
    if int(np.count_nonzero(ori_mask)) >= MIN_FIT_POINTS:
        orient_rms = _rms(orient_errs[ori_mask])
    else:
        orient_rms = _rms(orient_errs)
    inlier_res = residuals[inlier_idx]
    pos_rms = _rms(inlier_res)
    n_in = int(inlier_idx.size)
    axis = _axis_from_matrix(rotation)
    recipe = FlipRecipe(
        mirror_axis=axis,
        offset=(float(translation[0]), float(translation[1]), float(translation[2])),
        mirror_matrix=np.asarray(rotation, dtype=np.float64),
        tool_correction=tool_f,
        position_rms_mm=pos_rms,
        orientation_rms_deg=orient_rms,
        inliers=n_in,
        total=count,
        det_r=det_r,
        source_frame_id=source_frame_id,
        target_frame_id=target_frame_id,
        source_job_name=source_job_name,
        target_job_name=target_job_name,
        job_family=job_family,
    )
    return FlipFitResult(
        accepted=True,
        message=(
            f"Station mirror about {axis}: L=({translation[0]:.1f}, {translation[1]:.1f}, "
            f"{translation[2]:.1f}) mm, pos RMS {pos_rms:.2f} mm, orient RMS {orient_rms:.2f} deg, "
            f"{n_in}/{count} inliers."
        ),
        recipe=recipe,
        position_rms_mm=pos_rms,
        orientation_rms_deg=orient_rms,
        inliers=n_in,
        total=count,
        det_r=det_r,
        inlier_indices=[int(i) for i in inlier_idx],
    )


def umeyama_with_reflection(source: Mat, target: Mat) -> tuple[Mat, Vec]:
    """Rigid map target ≈ R @ source + t. Reflection is allowed (det(R) may be −1)."""
    if source.shape != target.shape or source.shape[0] < MIN_FIT_POINTS or source.shape[1] != 3:
        raise ValueError("umeyama_with_reflection needs Nx3 source and target with N>=3")
    mu_s = source.mean(axis=0)
    mu_t = target.mean(axis=0)
    src_c = source - mu_s
    dst_c = target - mu_t
    cov = (dst_c.T @ src_c) / float(source.shape[0])
    u_mat, _singular, vt = np.linalg.svd(cov)
    rotation = u_mat @ vt
    translation = mu_t - rotation @ mu_s
    return rotation, translation


def pulses_in_user_frame_list(
    pulse_rows: Sequence[Sequence[float]],
    user_frame: Pose,
    tool: Pose | None = None,
    params: AR2010Params | None = None,
) -> list[Pose]:
    return _pulses_in_uf(pulse_rows, user_frame, tool, params)


def flipped_pose_in_base(uf_pose: Pose, recipe: FlipRecipe | dict, uf_target: Pose) -> Pose:
    """UF-relative flipped pose expressed in manufacturer BASE."""
    return compose_poses(uf_target, apply_flip(uf_pose, recipe))


@dataclass
class FlipPointResult:
    index: int
    pose: Pose
    ik: IkResult

    def to_dict(self) -> dict[str, object]:
        payload = self.ik.to_dict()
        payload["index"] = self.index
        payload["pose"] = self.pose.to_dict()
        return payload


def apply_flip_with_ik(
    source_pulses: Sequence[Sequence[float]],
    recipe: FlipRecipe | dict,
    uf_source: Pose,
    uf_target: Pose,
    tool: Pose | None = None,
    params: AR2010Params | None = None,
    pulse_limits_pos: Sequence[float] | None = None,
    pulse_limits_neg: Sequence[float] | None = None,
    source_poses: Sequence[Pose] | None = None,
) -> list[FlipPointResult]:
    """Flip each source point in UF coords, IK in BASE, return target-UF poses."""
    rec = recipe if isinstance(recipe, FlipRecipe) else FlipRecipe.from_dict(recipe)
    tcp = tool if tool is not None else default_tool()
    model = params or default_params()
    if source_poses is not None:
        uf_poses = list(source_poses)
    else:
        uf_poses = _pulses_in_uf(source_pulses, uf_source, tcp, model)
    n_points = len(uf_poses)
    seeds: list[Sequence[float]] = list(source_pulses) if source_pulses else []
    results: list[FlipPointResult] = []
    for index in range(n_points):
        flipped_uf = apply_flip(uf_poses[index], rec)
        target_base = compose_poses(uf_target, flipped_uf)
        if index < len(seeds) and len(seeds[index]) >= 6:
            seed = seeds[index]
            try_flip_seed = True
        else:
            seed = list(HOME_PULSES)
            try_flip_seed = False
        ik_result = inverse_kinematics(
            target_base,
            seed,
            tool=tcp,
            params=model,
            pulse_limits_pos=pulse_limits_pos,
            pulse_limits_neg=pulse_limits_neg,
            try_station_flip_seed=try_flip_seed,
        )
        results.append(FlipPointResult(index=index, pose=flipped_uf, ik=ik_result))
    return results


def _pulses_in_uf(
    pulse_rows: Sequence[Sequence[float]],
    user_frame: Pose,
    tool: Pose | None,
    params: AR2010Params | None,
) -> list[Pose]:
    tcp = tool if tool is not None else default_tool()
    model = params or default_params()
    poses: list[Pose] = []
    for row in pulse_rows:
        result = forward_kinematics(row, tool=tcp, params=model)
        poses.append(relative_pose(result.pose, user_frame))
    return poses


def _position_residuals(src: Mat, dst: Mat, rotation: Mat, translation: Vec) -> Vec:
    predicted = (rotation @ src.T).T + translation
    return np.linalg.norm(predicted - dst, axis=1)


def _robust_umeyama(src: Mat, dst: Mat) -> tuple[Mat, Vec, Vec, NDArray[np.intp], float]:
    """Umeyama + iterated 3×-median inlier rejection."""
    inlier_idx = np.arange(src.shape[0], dtype=np.intp)
    rotation = np.eye(3, dtype=np.float64)
    translation = np.zeros(3, dtype=np.float64)
    residuals = np.zeros(src.shape[0], dtype=np.float64)
    threshold = 0.0
    for _ in range(8):
        if inlier_idx.size < MIN_FIT_POINTS:
            break
        rotation, translation = umeyama_with_reflection(src[inlier_idx], dst[inlier_idx])
        residuals = _position_residuals(src, dst, rotation, translation)
        mask, threshold = _inlier_mask(residuals)
        nxt = np.flatnonzero(mask)
        if nxt.size == inlier_idx.size and np.array_equal(nxt, inlier_idx):
            break
        inlier_idx = nxt
    return rotation, translation, residuals, inlier_idx, threshold


def _inlier_mask(
    residuals: Vec, min_threshold: float = 1.0
) -> tuple[NDArray[np.bool_], float]:
    if residuals.size == 0:
        return np.zeros((0,), dtype=np.bool_), 0.0
    median = float(np.median(residuals))
    threshold = max(RESIDUAL_MEDIAN_MULT * median, float(min_threshold))
    return residuals <= threshold, threshold


def _rms(values: Vec | Sequence[float]) -> float:
    arr = np.asarray(values, dtype=np.float64)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(arr))))


def _fit_tool_correction(
    src_rot: Sequence[Mat],
    dst_rot: Sequence[Mat],
    mirror: Mat,
    inlier_idx: NDArray[np.intp],
) -> Mat:
    """Pick F from discrete wrist conventions plus a polar-fitted mean."""
    svd_f = _svd_tool_correction(src_rot, dst_rot, mirror, inlier_idx)
    candidates = [
        TOOL_Y_FLIP.copy(),
        np.diag([-1.0, -1.0, 1.0]),
        np.diag([1.0, 1.0, -1.0]),
        np.diag([-1.0, 1.0, -1.0]),
        np.diag([-1.0, 1.0, 1.0]),
        np.diag([1.0, -1.0, -1.0]),
        svd_f,
    ]
    best = TOOL_Y_FLIP.copy()
    best_median = float("inf")
    for candidate in candidates:
        errors = [
            rotation_geodesic_deg(mirror @ src_rot[int(i)] @ candidate, dst_rot[int(i)])
            for i in inlier_idx
        ]
        median = float(np.median(errors)) if errors else float("inf")
        if median < best_median:
            best_median = median
            best = np.asarray(candidate, dtype=np.float64)
    return best


def _svd_tool_correction(
    src_rot: Sequence[Mat],
    dst_rot: Sequence[Mat],
    mirror: Mat,
    inlier_idx: NDArray[np.intp],
) -> Mat:
    stacked = []
    for index in inlier_idx:
        stacked.append(src_rot[int(index)].T @ mirror.T @ dst_rot[int(index)])
    if not stacked:
        return TOOL_Y_FLIP.copy()
    mean_f = np.mean(np.stack(stacked, axis=0), axis=0)
    u_mat, _s, vt = np.linalg.svd(mean_f)
    fitted = u_mat @ vt
    if abs(float(np.linalg.det(fitted))) < 1e-8:
        return TOOL_Y_FLIP.copy()
    return fitted


def _axis_from_matrix(rotation: Mat) -> str:
    """Name the reflection axis (eigenvector near eigenvalue −1)."""
    try:
        evals, evecs = np.linalg.eig(rotation)
        neg = int(np.argmin(evals.real))
        axis_vec = np.abs(evecs[:, neg].real)
        names = ("X", "Y", "Z")
        return names[int(np.argmax(axis_vec))]
    except np.linalg.LinAlgError:
        diag = np.abs(np.diag(rotation) + 1.0)
        return ("X", "Y", "Z")[int(np.argmin(diag))]


def _axis_to_matrix(axis: str) -> Mat:
    upper = axis.upper()
    if upper == "Y":
        return np.diag([1.0, -1.0, 1.0]).astype(np.float64)
    if upper == "Z":
        return np.diag([1.0, 1.0, -1.0]).astype(np.float64)
    return MIRROR_X.copy()


def _mat3_to_list(matrix: Mat) -> list[list[float]]:
    arr = np.asarray(matrix, dtype=np.float64).reshape(3, 3)
    return [[float(arr[i, j]) for j in range(3)] for i in range(3)]


def _mat3_from_unknown(value: object) -> Mat | None:
    if value is None:
        return None
    arr = np.asarray(value, dtype=np.float64)
    if arr.size == 9:
        return arr.reshape(3, 3)
    return None


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(value)
