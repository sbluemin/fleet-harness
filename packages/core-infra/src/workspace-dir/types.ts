export interface WorkspaceDirectory {
  readonly cwd: string;
  readonly identityPath: string;
  readonly name: string;
  readonly path: string;
  readonly root: string;
}

export interface WorkspaceDirectoryIdentity {
  readonly cwd: string;
}
