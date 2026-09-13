export function createMacDevWrapper(input: {
  electronBinary: string;
  stageDirectory: string;
  iconPath: string;
  cloneApp?: (sourcePath: string, destinationPath: string) => Promise<void>;
}): Promise<{ appPath: string; executablePath: string }>;
export function createInfoPlist(sourceInfo: string, electronAppPath: string): string;
export function createMacDevLaunchArguments(wrapperPath: string, appPath: string, args?: string[], env?: NodeJS.ProcessEnv): string[];
