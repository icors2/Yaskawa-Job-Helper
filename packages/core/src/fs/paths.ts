/** Join folder + file name using the separator already used by the folder path. */
export const joinPath = (root: string, name: string): string => {
  const sep = root.includes("\\") ? "\\" : "/"
  return `${root.replace(/[\\/]+$/, "")}${sep}${name}`
}
