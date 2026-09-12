export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  read(context?: { readonly sessionToken?: string }): Promise<string> | string;
}
