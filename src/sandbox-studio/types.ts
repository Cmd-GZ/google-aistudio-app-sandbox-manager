export type EntryType = 'dir' | 'file' | 'symlink';

export interface FileEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  mtimeMs: number;
  modeStr: string;
  extension: string;
  linkTarget?: string;
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export interface BookmarkItem {
  label: string;
  path: string;
}

export interface DirChildItem {
  name: string;
  path: string;
}

export interface FileReadResult {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  extension: string;
  isBinary: boolean;
  isImage: boolean;
  tooLarge: boolean;
  content: string;
}

export interface WorkspaceInfo {
  defaultPath: string;
  rootName: string;
  allowedRoots: string[];
  bookmarks: BookmarkItem[];
  platform: string;
  arch: string;
  nodeVersion: string;
  allowTerminal: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
  exitCode: number | null;
}

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isBinary: boolean;
  isImage: boolean;
  tooLarge: boolean;
  size: number;
  mtimeMs: number;
  extension: string;
  loading?: boolean;
}

export type SandboxStudioMode = 'standalone' | 'drawer';
