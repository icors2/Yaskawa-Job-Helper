export type PosType = "PULSE" | "USER" | "BASE" | "ROBOT" | "ANGLE"

export type PosVarKind = "C" | "BC" | "EC" | "P" | "BP" | "EX"

export interface HeaderLine {
  key: string
  value: string
  raw: string
}

export interface PosVar {
  kind: PosVarKind
  index: number
  values: string[]
  raw: string
}

export interface PosGroup {
  postype: PosType | string
  user?: string
  tool?: string
  headers: HeaderLine[]
  vars: PosVar[]
}

export interface InstLine {
  raw: string
  kind: "instruction" | "comment" | "label" | "blank"
}

export interface JobFile {
  name: string
  headers: HeaderLine[]
  posGroups: PosGroup[]
  instHeaders: HeaderLine[]
  instLines: InstLine[]
  newline: "\r\n"
}

export const emptyJob = (name: string): JobFile => ({
  name,
  headers: [],
  posGroups: [],
  instHeaders: [],
  instLines: [],
  newline: "\r\n"
})
