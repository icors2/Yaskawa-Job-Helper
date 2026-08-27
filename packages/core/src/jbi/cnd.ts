/** Inventory weld condition numbers from controller .CND files. */

export interface WeldConditionInventory {
  asf: Set<number>
  aef: Set<number>
  wev: Set<number>
}

export type WeldKind = "ASF" | "AEF" | "WEV"

const collectMatches = (text: string, pattern: RegExp): Set<number> => {
  const set = new Set<number>()
  for (const match of text.matchAll(pattern)) {
    set.add(Number.parseInt(match[1], 10))
  }
  return set
}

export const parseArcsrtNumbers = (text: string): Set<number> => {
  return collectMatches(text, /^\/\/ARCSRT\s+EN\s+(\d+)/gm)
}

export const parseArcendNumbers = (text: string): Set<number> => {
  return collectMatches(text, /^\/\/ARCEND\s+EN\s+(\d+)/gm)
}

export const parseWeavNumbers = (text: string): Set<number> => {
  return collectMatches(text, /^\/\/WEAV\s+(\d+)/gm)
}

export const buildWeldInventory = (parts: {
  arcsrt?: string
  arcend?: string
  weav?: string
}): WeldConditionInventory => ({
  asf: parts.arcsrt ? parseArcsrtNumbers(parts.arcsrt) : new Set(),
  aef: parts.arcend ? parseArcendNumbers(parts.arcend) : new Set(),
  wev: parts.weav ? parseWeavNumbers(parts.weav) : new Set()
})

export const inventoryHas = (
  inventory: WeldConditionInventory,
  kind: WeldKind,
  n: number
): boolean => {
  if (kind === "ASF") {
    return inventory.asf.has(n)
  }
  if (kind === "AEF") {
    return inventory.aef.has(n)
  }
  return inventory.wev.has(n)
}

export const inventoryLabel = (kind: WeldKind): string => {
  if (kind === "ASF") {
    return "ARCSRT.CND"
  }
  if (kind === "AEF") {
    return "ARCEND.CND"
  }
  return "WEAV.CND"
}
