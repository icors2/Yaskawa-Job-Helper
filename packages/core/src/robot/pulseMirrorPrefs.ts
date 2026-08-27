/**
 * Optional advanced pulse-axis sign flips for single-side / mirror ops.
 *
 * Defaults are identity (no flips) and undocumented until the cell is calibrated.
 * Prefer cartesian USER/BASE mirror via FK — joint-level mirroring is approximate.
 */

import { getStoragePort } from "../ports/storage"

export type PulseAxis = "S" | "L" | "U" | "R" | "B" | "T"

export const PULSE_AXIS_ORDER: PulseAxis[] = ["S", "L", "U", "R", "B", "T"]

/** Per-axis multiply signs for S,L,U,R,B,T. +1 = keep, −1 = negate. */
export type PulseMirrorAxisSigns = [number, number, number, number, number, number]

export interface PulseMirrorPrefs {
  version: 1
  /** When true, Transform may offer pulse-axis flips instead of FK→cartesian mirror. */
  advancedEnabled: boolean
  signs: PulseMirrorAxisSigns
}

export const DEFAULT_PULSE_MIRROR_SIGNS: PulseMirrorAxisSigns = [1, 1, 1, 1, 1, 1]

export const DEFAULT_PULSE_MIRROR_PREFS: PulseMirrorPrefs = {
  version: 1,
  advancedEnabled: false,
  signs: [...DEFAULT_PULSE_MIRROR_SIGNS]
}

export const pulseMirrorStorageKey = (profileId: string): string =>
  `yaskawa.pulseMirror.v1.${profileId}`

export const loadPulseMirrorPrefs = (profileId: string | null): PulseMirrorPrefs => {
  if (!profileId) {
    return { ...DEFAULT_PULSE_MIRROR_PREFS, signs: [...DEFAULT_PULSE_MIRROR_SIGNS] }
  }
  try {
    const raw = getStoragePort().getItem(pulseMirrorStorageKey(profileId))
    if (!raw) {
      return { ...DEFAULT_PULSE_MIRROR_PREFS, signs: [...DEFAULT_PULSE_MIRROR_SIGNS] }
    }
    const parsed = JSON.parse(raw) as Partial<PulseMirrorPrefs>
    const signs: PulseMirrorAxisSigns =
      Array.isArray(parsed.signs) && parsed.signs.length === 6
        ? [
            Number(parsed.signs[0]) < 0 ? -1 : 1,
            Number(parsed.signs[1]) < 0 ? -1 : 1,
            Number(parsed.signs[2]) < 0 ? -1 : 1,
            Number(parsed.signs[3]) < 0 ? -1 : 1,
            Number(parsed.signs[4]) < 0 ? -1 : 1,
            Number(parsed.signs[5]) < 0 ? -1 : 1
          ]
        : [...DEFAULT_PULSE_MIRROR_SIGNS]
    return {
      version: 1,
      advancedEnabled: Boolean(parsed.advancedEnabled),
      signs
    }
  } catch {
    return { ...DEFAULT_PULSE_MIRROR_PREFS, signs: [...DEFAULT_PULSE_MIRROR_SIGNS] }
  }
}

export const savePulseMirrorPrefs = (
  profileId: string,
  prefs: PulseMirrorPrefs
): PulseMirrorPrefs => {
  const next: PulseMirrorPrefs = {
    version: 1,
    advancedEnabled: prefs.advancedEnabled,
    signs: [
      prefs.signs[0] < 0 ? -1 : 1,
      prefs.signs[1] < 0 ? -1 : 1,
      prefs.signs[2] < 0 ? -1 : 1,
      prefs.signs[3] < 0 ? -1 : 1,
      prefs.signs[4] < 0 ? -1 : 1,
      prefs.signs[5] < 0 ? -1 : 1
    ]
  }
  getStoragePort().setItem(pulseMirrorStorageKey(profileId), JSON.stringify(next))
  return next
}

export const applyPulseAxisSigns = (
  pulses: number[],
  signs: PulseMirrorAxisSigns
): number[] =>
  pulses.map((value, index) => {
    const sign = signs[index] ?? 1
    return value * sign
  })
