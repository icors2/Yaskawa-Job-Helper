/**
 * @yaskawa/core — platform-agnostic Yaskawa job editing core.
 *
 * Nothing here touches Tauri, the filesystem, or the network. Deep imports
 * are the primary entry point (`@yaskawa/core/kin/fk`,
 * `@yaskawa/core/jbi/parse`); this barrel groups them by area so a shell can
 * pull in one namespace instead of a dozen paths.
 */

export * as calibration from "./calibration/index"
export * as jbi from "./jbi/index"
export * as kin from "./kin/index"
export * as robot from "./robot/index"
export * as paths from "./fs/paths"
export * as setup from "./setup/progress"
export * as ports from "./ports/index"
