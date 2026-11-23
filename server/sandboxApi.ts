import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import JSZip from 'jszip';
import multer from 'multer';

export interface SandboxRouterOptions {
  /** Default starting directory in the file manager and terminal. Defaults to process.cwd(). */
  defaultDir?: string;
  /** Whether to enable the interactive terminal endpoints. Defaults to true. */
  allowTerminal?: boolean;
  /** Maximum upload file size in bytes. Defaults to 200 MB. */
  maxUploadBytes?: number;
}

interface TerminalSession {
  id: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
  exitCode: number | null;
  proc: ChildProcess;
  history: Buffer;
  clients: Set<Response>;
}

const MAX_TERMINAL_BUFFER = 256 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
};

const PTY_PY_SCRIPT = `
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = sys.argv[1] if len(sys.argv) > 1 else "/bin/bash"
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 100
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 28

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    try:
        os.close(3)
    except OSError:
        pass
    os.execvp(shell, [shell, "-i"])
    os._exit(127)

os.close(slave)
os.set_blocking(0, False)
os.set_blocking(master, False)

try:
    os.set_blocking(3, False)
    has_ctrl = True
except OSError:
    has_ctrl = False

ctrl_buf = b""
exit_code = 0

def write_all(fd, data):
    view = memoryview(data)
    while len(view) > 0:
        try:
            n = os.write(fd, view)
            view = view[n:]
        except BlockingIOError:
            select.select([], [fd], [], 0.05)

while True:
    watch = [master, 0]
    if has_ctrl:
        watch.append(3)
    try:
        rlist, _, _ = select.select(watch, [], [], 0.2)
    except InterruptedError:
        continue

    if 0 in rlist:
        try:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            write_all(master, chunk)
        except BlockingIOError:
            pass
        except OSError:
            break

    if has_ctrl and 3 in rlist:
        try:
            c = os.read(3, 4096)
            if not c:
                has_ctrl = False
            else:
                ctrl_buf += c
                while b"\\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\\n", 1)
                    parts = line.decode("utf-8", "ignore").strip().split()
                    if len(parts) == 3 and parts[0] == "RESIZE":
                        c_cols = max(10, min(500, int(parts[1])))
                        c_rows = max(4, min(200, int(parts[2])))
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", c_rows, c_cols, 0, 0))
                        try:
                            os.kill(pid, signal.SIGWINCH)
                        except OSError:
                            pass
        except BlockingIOError:
            pass
        except OSError:
            has_ctrl = False

    if master in rlist:
        try:
            out = os.read(master, 65536)
            if not out:
                break
            write_all(1, out)
        except BlockingIOError:
            pass
        except OSError:
            break

    waited_pid, status = os.waitpid(pid, os.WNOHANG)
    if waited_pid == pid:
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_code = 128 + os.WTERMSIG(status)
        break

try:
    os.close(master)
except OSError:
    pass
try:
    os.kill(pid, signal.SIGTERM)
except OSError:
    pass
sys.exit(exit_code)
`;

function isBufferBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function createSandboxRouter(options: SandboxRouterOptions = {}): Router {
  const defaultDir = path.resolve(options.defaultDir || process.cwd());
  const allowTerminal = options.allowTerminal !== false;
  const maxUploadBytes = options.maxUploadBytes || 200 * 1024 * 1024;
  const sessions = new Map<string, TerminalSession>();

  const router = express.Router();
  router.use(express.json({ limit: '10mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 500,
    },
  });

  function resolvePath(rawInput: unknown, mustExist = false): string {
    const raw = typeof rawInput === 'string' && rawInput.trim() ? rawInput.trim() : defaultDir;
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(defaultDir, raw);
    if (mustExist && !fs.existsSync(resolved)) {
      throw new Error(`Path not found: ${resolved}`);
    }
    return resolved;
  }

  function buildBreadcrumbs(targetPath: string): Array<{ name: string; path: string }> {
    const resolved = path.resolve(targetPath);
    const crumbs: Array<{ name: string; path: string }> = [{ name: '/', path: '/' }];
    const parts = resolved.split(path.sep).filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = `${acc}${path.sep}${part}`;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }

  // --- Healthcheck ---
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      pid: process.pid,
      activeTerminals: Array.from(sessions.values()).filter((s) => s.alive).length,
    });
  });

  // --- Workspace Info ---
  router.get('/info', (_req: Request, res: Response) => {
    res.json({
      defaultPath: defaultDir,
      rootName: path.basename(defaultDir) || '/',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      allowTerminal,
    });
  });

  // --- File Listing ---
  router.get('/fs/list', (req: Request, res: Response) => {
    try {
      const targetDir = resolvePath(req.query.path, true);
      const showHidden = req.query.showHidden === 'true';
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Target path is not a directory' });
        return;
      }

      const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
      const entries = dirents
        .filter((d) => showHidden || !d.name.startsWith('.'))
        .map((d) => {
          const full = path.join(targetDir, d.name);
          let type: 'dir' | 'file' | 'symlink' = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file';
          let size = 0;
          let mtimeMs = 0;
          let linkTarget: string | undefined;

          try {
            const lst = fs.lstatSync(full);
            mtimeMs = lst.mtimeMs;
            if (lst.isSymbolicLink()) {
              linkTarget = fs.readlinkSync(full);
              try {
                const targetStat = fs.statSync(full);
                if (targetStat.isDirectory()) type = 'dir';
                size = targetStat.size;
                mtimeMs = targetStat.mtimeMs;
              } catch {
                type = 'symlink';
              }
            } else {
              type = lst.isDirectory() ? 'dir' : 'file';
              size = lst.size;
            }
          } catch {
            // Unreadable entry
          }

          return {
            name: d.name,
            path: full,
            type,
            size,
            mtimeMs,
            extension: type === 'dir' ? '' : path.extname(d.name).toLowerCase(),
            linkTarget,
          };
        })
        .sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

      const parentCandidate = path.dirname(targetDir);
      const parent = parentCandidate !== targetDir ? parentCandidate : null;

      res.json({
        path: targetDir,
        parent,
        breadcrumbs: buildBreadcrumbs(targetDir),
        entries,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list directory' });
    }
  });

  // --- Lazy Subdirectory Tree ---
  router.get('/fs/tree', (req: Request, res: Response) => {
    try {
      const targetDir = resolvePath(req.query.path || '/', true);
      const showHidden = req.query.showHidden === 'true';
      const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
      const dirs: Array<{ name: string; path: string }> = [];

      for (const d of dirents) {
        if (!showHidden && d.name.startsWith('.')) continue;
        const full = path.join(targetDir, d.name);
        if (d.isDirectory()) {
          dirs.push({ name: d.name, path: full });
        } else if (d.isSymbolicLink()) {
          try {
            if (fs.statSync(full).isDirectory()) {
              dirs.push({ name: d.name, path: full });
            }
          } catch {
            // Ignore broken symlinks
          }
        }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      res.json({ path: targetDir, dirs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read directory tree' });
    }
  });

  // --- Read File ---
  router.get('/fs/read', (req: Request, res: Response) => {
    try {
      const target = resolvePath(req.query.path, true);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Cannot read a directory as a file' });
        return;
      }

      const ext = path.extname(target).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(ext);

      if (stat.size > MAX_READ_BYTES && !isImage) {
        res.json({
          path: target,
          name: path.basename(target),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          extension: ext,
          isBinary: true,
          isImage: false,
          tooLarge: true,
          content: '',
        });
        return;
      }

      if (isImage && ext !== '.svg') {
        res.json({
          path: target,
          name: path.basename(target),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          extension: ext,
          isBinary: true,
          isImage: true,
          tooLarge: false,
          content: '',
        });
        return;
      }

      const buf = fs.readFileSync(target);
      const isBinary = isBufferBinary(buf);

      res.json({
        path: target,
        name: path.basename(target),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        extension: ext,
        isBinary,
        isImage,
        tooLarge: false,
        content: isBinary ? '' : buf.toString('utf8'),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read file' });
    }
  });

  // --- Raw File Stream ---
  router.get('/fs/raw', (req: Request, res: Response) => {
    try {
      const target = resolvePath(req.query.path, true);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Target is a directory' });
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.sendFile(target);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'File not found' });
    }
  });

  // --- Download Single File ---
  router.get('/fs/download', (req: Request, res: Response) => {
    try {
      const target = resolvePath(req.query.path, true);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Use ZIP download for directories' });
        return;
      }
      res.download(target, path.basename(target));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Download failed' });
    }
  });

  // --- Download Folder or Selected Paths as ZIP ---
  router.get('/fs/download-zip', async (req: Request, res: Response) => {
    try {
      const rawPaths = req.query.paths;
      const singlePath = typeof req.query.path === 'string' ? req.query.path : undefined;
      const requestedList: string[] = [];

      if (typeof rawPaths === 'string' && rawPaths.length > 0) {
        requestedList.push(...rawPaths.split(',').map((s) => s.trim()).filter(Boolean));
      } else if (Array.isArray(rawPaths)) {
        for (const item of rawPaths) {
          if (typeof item === 'string' && item.trim()) requestedList.push(item.trim());
        }
      } else if (singlePath) {
        requestedList.push(singlePath);
      } else {
        requestedList.push(defaultDir);
      }

      const zip = new JSZip();
      let totalFilesAdded = 0;
      const MAX_ZIP_FILES = 3000;
      const SKIP_VIRTUAL_DIRS = new Set(['proc', 'sys', 'dev']);

      function addDirectoryToZip(dirPath: string, zipFolder: JSZip, isExplicitRoot: boolean) {
        let items: fs.Dirent[];
        try {
          items = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (totalFilesAdded >= MAX_ZIP_FILES) break;
          if (dirPath === '/' && SKIP_VIRTUAL_DIRS.has(item.name)) continue;
          if ((item.name === 'node_modules' || item.name === '.git') && !isExplicitRoot) {
            continue;
          }
          const full = path.join(dirPath, item.name);
          let st: fs.Stats;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            const sub = zipFolder.folder(item.name);
            if (sub) addDirectoryToZip(full, sub, false);
          } else if (st.isFile()) {
            try {
              zipFolder.file(item.name, fs.readFileSync(full));
              totalFilesAdded++;
            } catch {
              // Skip unreadable file
            }
          }
        }
      }

      for (const reqPath of requestedList) {
        const target = resolvePath(reqPath, true);
        const st = fs.statSync(target);
        const name = path.basename(target) || 'sandbox-root';
        if (st.isDirectory()) {
          const folder = zip.folder(name);
          if (folder) addDirectoryToZip(target, folder, true);
        } else if (st.isFile()) {
          zip.file(name, fs.readFileSync(target));
          totalFilesAdded++;
        }
      }

      const zipName =
        requestedList.length === 1
          ? `${path.basename(requestedList[0]) || 'sandbox'}.zip`
          : 'sandbox-files.zip';

      const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
      res.send(buffer);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'ZIP creation failed' });
    }
  });

  // --- Write File ---
  router.post('/fs/write', (req: Request, res: Response) => {
    try {
      const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!rawPath.trim()) {
        res.status(400).json({ error: 'File path is required' });
        return;
      }
      const target = resolvePath(rawPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      const st = fs.statSync(target);
      res.json({
        ok: true,
        path: target,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to write file' });
    }
  });

  // --- Create Directory ---
  router.post('/fs/mkdir', (req: Request, res: Response) => {
    try {
      const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!rawPath.trim()) {
        res.status(400).json({ error: 'Directory path is required' });
        return;
      }
      const target = resolvePath(rawPath);
      fs.mkdirSync(target, { recursive: true });
      res.json({ ok: true, path: target });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create directory' });
    }
  });

  // --- Rename / Move ---
  router.post('/fs/rename', (req: Request, res: Response) => {
    try {
      const oldRaw = typeof req.body?.oldPath === 'string' ? req.body.oldPath : '';
      const newRaw = typeof req.body?.newPath === 'string' ? req.body.newPath : '';
      if (!oldRaw.trim() || !newRaw.trim()) {
        res.status(400).json({ error: 'Both oldPath and newPath are required' });
        return;
      }
      const oldTarget = resolvePath(oldRaw, true);
      const newTarget = resolvePath(newRaw);
      if (fs.existsSync(newTarget)) {
        res.status(409).json({ error: 'Destination already exists' });
        return;
      }
      fs.mkdirSync(path.dirname(newTarget), { recursive: true });
      fs.renameSync(oldTarget, newTarget);
      res.json({ ok: true, oldPath: oldTarget, newPath: newTarget });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Rename failed' });
    }
  });

  // --- Delete File or Directory ---
  router.delete('/fs/delete', (req: Request, res: Response) => {
    try {
      const rawPath =
        typeof req.query.path === 'string'
          ? req.query.path
          : typeof req.body?.path === 'string'
            ? req.body.path
            : '';
      if (!rawPath.trim()) {
        res.status(400).json({ error: 'Path is required' });
        return;
      }
      const target = resolvePath(rawPath, true);
      fs.rmSync(target, { recursive: true, force: true });
      res.json({ ok: true, deleted: target });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // --- Upload Files / Directories Recursively ---
  router.post('/fs/upload', upload.array('files', 500), (req: Request, res: Response) => {
    try {
      const targetDir = resolvePath(req.body?.targetDir || defaultDir, true);
      const dirStat = fs.statSync(targetDir);
      if (!dirStat.isDirectory()) {
        res.status(400).json({ error: 'Upload destination is not a directory' });
        return;
      }

      let relativePaths: string[] = [];
      if (typeof req.body?.relativePaths === 'string') {
        try {
          const parsed = JSON.parse(req.body.relativePaths);
          if (Array.isArray(parsed)) {
            relativePaths = parsed.map((p) => (typeof p === 'string' ? p : ''));
          }
        } catch {
          // Ignore malformed relativePaths
        }
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      const saved: Array<{ path: string; size: number }> = [];
      files.forEach((file, idx) => {
        const rawName = (relativePaths[idx] || file.originalname || `upload-${idx}`)
          .replace(/\\/g, '/')
          .replace(/^\/+/, '');
        const dest = path.resolve(targetDir, rawName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.buffer);
        saved.push({ path: dest, size: file.size });
      });

      res.json({ ok: true, uploaded: saved });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  // --- Real PTY Interactive Terminal Routes ---
  function appendHistory(session: TerminalSession, chunk: Buffer): void {
    const combined = Buffer.concat([session.history, chunk]);
    session.history =
      combined.length > MAX_TERMINAL_BUFFER
        ? combined.subarray(combined.length - MAX_TERMINAL_BUFFER)
        : combined;
  }

  function sendSse(res: Response, event: string, payload: unknown): void {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function buildTerminalEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const pathParts = (
      env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    ).split(':');
    for (const extra of ['/root/bin', '/root/.local/bin']) {
      if (fs.existsSync(extra) && !pathParts.includes(extra)) {
        pathParts.unshift(extra);
      }
    }
    env.PATH = pathParts.join(':');
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.LANG = env.LANG || 'C.UTF-8';
    env.HOME = env.HOME || '/root';
    return env;
  }

  function spawnPtySession(cwd: string, cols: number, rows: number): TerminalSession {
    const id = crypto.randomUUID().slice(0, 8);
    const safeCols = Math.max(20, Math.min(400, Math.floor(cols || 100)));
    const safeRows = Math.max(6, Math.min(160, Math.floor(rows || 28)));
    const shellBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

    const proc = spawn(
      'python3',
      ['-u', '-c', PTY_PY_SCRIPT, shellBin, String(safeCols), String(safeRows)],
      {
        cwd,
        env: buildTerminalEnv(),
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        shell: false,
      }
    );

    const session: TerminalSession = {
      id,
      cwd,
      createdAt: Date.now(),
      alive: true,
      exitCode: null,
      proc,
      history: Buffer.alloc(0),
      clients: new Set(),
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      appendHistory(session, chunk);
      const b64 = chunk.toString('base64');
      for (const client of session.clients) {
        sendSse(client, 'data', { b64 });
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      appendHistory(session, chunk);
      const b64 = chunk.toString('base64');
      for (const client of session.clients) {
        sendSse(client, 'data', { b64 });
      }
    });

    proc.on('close', (code) => {
      session.alive = false;
      session.exitCode = code ?? 0;
      for (const client of session.clients) {
        sendSse(client, 'exit', { exitCode: session.exitCode });
      }
    });

    sessions.set(id, session);
    return session;
  }

  if (allowTerminal) {
    router.get('/terminal/sessions', (_req: Request, res: Response) => {
      const list = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        cwd: s.cwd,
        createdAt: s.createdAt,
        alive: s.alive,
        exitCode: s.exitCode,
      }));
      res.json({ sessions: list });
    });

    router.post('/terminal/sessions', (req: Request, res: Response) => {
      try {
        let cwd = defaultDir;
        if (typeof req.body?.cwd === 'string' && req.body.cwd.trim()) {
          cwd = resolvePath(req.body.cwd, true);
        }
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) {
          cwd = path.dirname(cwd);
        }
        const cols = Number(req.body?.cols || 100);
        const rows = Number(req.body?.rows || 28);
        const session = spawnPtySession(cwd, cols, rows);
        res.json({
          id: session.id,
          cwd: session.cwd,
          createdAt: session.createdAt,
          alive: session.alive,
          exitCode: session.exitCode,
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create terminal session' });
      }
    });

    router.get('/terminal/sessions/:id/stream', (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Terminal session not found' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      session.clients.add(res);

      if (session.history.length > 0) {
        sendSse(res, 'replay', { b64: session.history.toString('base64') });
      }
      if (!session.alive) {
        sendSse(res, 'exit', { exitCode: session.exitCode ?? 0 });
      }

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      }, 20000);

      req.on('close', () => {
        clearInterval(heartbeat);
        session.clients.delete(res);
      });
    });

    router.post('/terminal/sessions/:id/input', (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session || !session.alive) {
        res.status(404).json({ error: 'Active terminal session not found' });
        return;
      }
      const rawData = typeof req.body?.data === 'string' ? req.body.data : '';
      const buf = req.body?.isBase64 ? Buffer.from(rawData, 'base64') : Buffer.from(rawData, 'utf8');
      if (session.proc.stdin && !session.proc.stdin.destroyed) {
        session.proc.stdin.write(buf);
      }
      res.json({ ok: true });
    });

    router.post('/terminal/sessions/:id/resize', (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session || !session.alive) {
        res.status(404).json({ error: 'Active terminal session not found' });
        return;
      }
      const cols = Math.max(10, Math.min(500, Math.floor(Number(req.body?.cols || 100))));
      const rows = Math.max(4, Math.min(200, Math.floor(Number(req.body?.rows || 28))));
      const ctrl = session.proc.stdio[3];
      if (ctrl && 'write' in ctrl && typeof ctrl.write === 'function') {
        ctrl.write(`RESIZE ${cols} ${rows}\n`);
      }
      res.json({ ok: true });
    });

    router.delete('/terminal/sessions/:id', (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (session) {
        try {
          session.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        for (const client of session.clients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
        sessions.delete(req.params.id);
      }
      res.json({ ok: true });
    });
  }

  return router;
}
