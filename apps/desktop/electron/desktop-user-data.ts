import path from 'node:path'

const COMPATIBLE_USER_DATA_NAME = 'Costas Code'

interface DesktopUserDataPathOptions {
  appDataPath: string
  overridePath?: string | null
}

function resolveDesktopUserDataPath({ appDataPath, overridePath }: DesktopUserDataPathOptions): string {
  return overridePath ? path.resolve(overridePath) : path.join(appDataPath, COMPATIBLE_USER_DATA_NAME)
}

export { COMPATIBLE_USER_DATA_NAME, resolveDesktopUserDataPath }
