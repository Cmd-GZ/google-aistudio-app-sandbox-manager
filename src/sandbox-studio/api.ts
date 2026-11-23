import {
  BreadcrumbItem,
  DirChildItem,
  FileEntry,
  FileReadResult,
  TerminalSessionInfo,
  WorkspaceInfo,
} from './types';

export interface SandboxClient {
  baseUrl: string;
  getInfo: () => Promise<WorkspaceInfo>;
  listDir: (
    absPath: string,
    showHidden: boolean
  ) => Promise<{ path: string; parent: string | null; breadcrumbs: BreadcrumbItem[]; entries: FileEntry[] }>;
  getTreeDirs: (absPath: string, showHidden: boolean) => Promise<{ path: string; dirs: DirChildItem[] }>;
  readFile: (absPath: string) => Promise<FileReadResult>;
  writeFile: (absPath: string, content: string) => Promise<{ ok: boolean; path: string; size: number; mtimeMs: number }>;
  mkdir: (absPath: string) => Promise<{ ok: boolean; path: string }>;
  rename: (oldPath: string, newPath: string) => Promise<{ ok: boolean; oldPath: string; newPath: string }>;
  deletePath: (absPath: string) => Promise<{ ok: boolean; deleted: string }>;
  uploadFiles: (
    files: File[],
    targetDir: string,
    relativePaths?: string[],
    onProgress?: (percent: number) => void
  ) => Promise<{ ok: boolean; uploaded: Array<{ path: string; size: number }> }>;
  getRawUrl: (absPath: string) => string;
  getDownloadUrl: (absPath: string) => string;
  getDownloadZipUrl: (paths: string[]) => string;
  listTerminalSessions: () => Promise<{ sessions: TerminalSessionInfo[] }>;
  createTerminalSession: (cwd?: string, cols?: number, rows?: number) => Promise<TerminalSessionInfo>;
  getTerminalStreamUrl: (sessionId: string) => string;
  sendTerminalInput: (sessionId: string, data: string) => Promise<void>;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminalSession: (sessionId: string) => Promise<void>;
}

export function createSandboxClient(baseUrl = '/api/sandbox'): SandboxClient {
  const cleanBase = baseUrl.replace(/\/+$/, '');

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${cleanBase}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
    }
    return data as T;
  }

  return {
    baseUrl: cleanBase,
    getInfo() {
      return requestJson<WorkspaceInfo>('/info');
    },
    listDir(absPath: string, showHidden: boolean) {
      const q = new URLSearchParams({ path: absPath, showHidden: String(showHidden) });
      return requestJson<{
        path: string;
        parent: string | null;
        breadcrumbs: BreadcrumbItem[];
        entries: FileEntry[];
      }>(`/fs/list?${q.toString()}`);
    },
    getTreeDirs(absPath: string, showHidden: boolean) {
      const q = new URLSearchParams({
        path: absPath,
        showHidden: String(showHidden),
      });
      return requestJson<{ path: string; dirs: DirChildItem[] }>(`/fs/tree?${q.toString()}`);
    },
    readFile(absPath: string) {
      const q = new URLSearchParams({ path: absPath });
      return requestJson<FileReadResult>(`/fs/read?${q.toString()}`);
    },
    writeFile(absPath: string, content: string) {
      return requestJson<{ ok: boolean; path: string; size: number; mtimeMs: number }>('/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absPath, content }),
      });
    },
    mkdir(absPath: string) {
      return requestJson<{ ok: boolean; path: string }>('/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absPath }),
      });
    },
    rename(oldPath: string, newPath: string) {
      return requestJson<{ ok: boolean; oldPath: string; newPath: string }>('/fs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newPath }),
      });
    },
    deletePath(absPath: string) {
      const q = new URLSearchParams({ path: absPath });
      return requestJson<{ ok: boolean; deleted: string }>(`/fs/delete?${q.toString()}`, {
        method: 'DELETE',
      });
    },
    uploadFiles(files: File[], targetDir: string, relativePaths?: string[], onProgress?: (percent: number) => void) {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('targetDir', targetDir);
        if (relativePaths && relativePaths.length > 0) {
          form.append('relativePaths', JSON.stringify(relativePaths));
        }
        files.forEach((f) => form.append('files', f));

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${cleanBase}/fs/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable && onProgress) {
            onProgress(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText || '{}');
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || `Upload failed (${xhr.status})`));
            }
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(form);
      });
    },
    getRawUrl(absPath: string) {
      const q = new URLSearchParams({ path: absPath });
      return `${cleanBase}/fs/raw?${q.toString()}`;
    },
    getDownloadUrl(absPath: string) {
      const q = new URLSearchParams({ path: absPath });
      return `${cleanBase}/fs/download?${q.toString()}`;
    },
    getDownloadZipUrl(paths: string[]) {
      const q = new URLSearchParams();
      if (paths.length > 0) {
        q.set('paths', paths.join(','));
      }
      return `${cleanBase}/fs/download-zip?${q.toString()}`;
    },
    listTerminalSessions() {
      return requestJson<{ sessions: TerminalSessionInfo[] }>('/terminal/sessions');
    },
    createTerminalSession(cwd?: string, cols = 100, rows = 28) {
      return requestJson<TerminalSessionInfo>('/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: cwd || '', cols, rows }),
      });
    },
    getTerminalStreamUrl(sessionId: string) {
      return `${cleanBase}/terminal/sessions/${encodeURIComponent(sessionId)}/stream`;
    },
    async sendTerminalInput(sessionId: string, data: string) {
      await requestJson<{ ok: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
    },
    async resizeTerminal(sessionId: string, cols: number, rows: number) {
      await requestJson<{ ok: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      });
    },
    async closeTerminalSession(sessionId: string) {
      await requestJson<{ ok: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
    },
  };
}
