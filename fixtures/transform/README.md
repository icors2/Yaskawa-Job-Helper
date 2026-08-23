# Transform fixtures

Synthetic **USER-frame cartesian** jobs for validating transfer / Flip convert / mirror / single-side mirror **before** real cartesian backups are uploaded from the cell.

## Source geometry

- Pose pattern adapted from `fixtures/CUT_ONLY.JBI` (USER section).
- Frame numbers match DYNAMIC1 `UFRAME.CND`: **UF2 = S1**, **UF3 = S2**.
- `BUSER` / tool data for S1/S2 live in `fixtures/transform/UFRAME.CND` (and cell `UFRAME.CND`).

## Files

| File | Role |
| --- | --- |
| `USER_CART_S1.JBI` | Source job — `///USER 2`, four cartesian P poses |
| `USER_CART_S1_UF3.JBI` | Transfer UF2→UF3 (identical fixtures) — poses unchanged, only `///USER` / `NAME` |
| `USER_CART_S1_FLIP_UF3.JBI` | Frame convert (Flip) UF2→UF3 using BUSER from `UFRAME.CND` + tool Z 180° |
| `USER_CART_S1_MYZ.JBI` | Mirror YZ in same UF2 — X (and related Rx/Rz) reflected |
| `USER_CART_S1_SSM_L_YZ.JBI` | Single-side left, YZ, same UF2 (same pose math as `MYZ`) |
| `USER_CART_S1_SSM_R_YZ.JBI` | Single-side right, YZ, same UF2 (same pose math as `MYZ`) |
| `USER_CART_S1_OFF_X100.JBI` | Offset +100 mm X in same UF2 — XYZ shift only |
| `UFRAME.CND` | Mini UFRAME with UF1/2/3 BUSER for Flip / profile tests |

## When real backups arrive

1. Drop cartesian `///POSTYPE USER` jobs from the pendant/backup here (keep names clear).
2. Re-run `npm run test:transform` and `npm run test:kin`.
3. Re-validate **mirror**, **offset/shift**, and **Frame convert (Flip)** against those cell jobs (synthetic fixtures are stand-ins until then).
4. Do **not** invent pulse-mirror ground truth — PULSE single-side mirror uses FK→cartesian (recommended) or optional approximate axis-sign knobs after cell calibration. Flip convert refuses integer PULSE rows (cartesian only).

## Tests

```bash
npm run test:transform
npm run test:kin
```

Assertions check `///USER` labels and pose sign/frame patterns — not full byte-identical match to unknown human data.
