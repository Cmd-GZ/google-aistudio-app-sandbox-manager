import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderArchive,
  FolderPlus,
  Link2,
  Moon,
  Pencil,
  Search,
  Square,
  Sun,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { createSandboxClient } from './api';
import { FilePreviewEditor } from './FilePreviewEditor';
import { FileTree } from './FileTree';
import { TerminalPane } from './TerminalPane';
import {
  BreadcrumbItem,
  FileEntry,
  OpenFileTab,
  SandboxStudioMode,
} from './types';
import { formatBytes, formatTimestamp, getBasename, getParentPath, joinPosixPath } from './utils';

export interface SandboxStudioProps {
  /** 'standalone' fills the viewport; 'drawer' renders a floating trigger button + slide-up overlay for embedding in other apps. */
  mode?: SandboxStudioMode;
  /** Backend API mount prefix. Defaults to '/api/sandbox'. */
  apiBaseUrl?: string;
}

type LayoutView = 'split' | 'explorer' | 'terminal';

type DialogState =
  | { kind: 'new-file'; baseDir: string; value: string }
  | { kind: 'new-folder'; baseDir: string; value: string }
  | { kind: 'rename'; entry: FileEntry; value: string }
  | { kind: 'delete'; paths: string[] }
  | null;

interface DroppedFileItem {
  file: File;
  relativePath: string;
}

async function collectDroppedItems(dataTransfer: DataTransfer): Promise<DroppedFileItem[]> {
  const items = Array.from(dataTransfer.items || []);
  const results: DroppedFileItem[] = [];

  async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      const rel = prefix ? `${prefix}/${file.name}` : file.name;
      results.push({ file, relativePath: rel });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;

      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));

      let batch = await readBatch();
      while (batch.length > 0) {
        for (const child of batch) {
          await walkEntry(child, nextPrefix);
        }
        batch = await readBatch();
      }
    }
  }

  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length > 0) {
    for (const entry of entries) {
      await walkEntry(entry, '');
    }
    return results;
  }

  return Array.from(dataTransfer.files || []).map((file) => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

export const SandboxStudio: React.FC<SandboxStudioProps> = ({
  mode = 'standalone',
  apiBaseUrl = '/api/sandbox',
}) => {
  const client = useMemo(() => createSandboxClient(apiBaseUrl), [apiBaseUrl]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : true
  );

  // Workspace & FS state
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [searchFilter, setSearchFilter] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // Open file tabs & center view
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<'directory' | 'editor'>('directory');

  // Layout & UI controls
  const [layoutView, setLayoutView] = useState<LayoutView>('split');
  const [terminalHeight, setTerminalHeight] = useState(300);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);

  // Upload & toast feedback
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [bannerNotice, setBannerNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);
  const dragCounterRef = useRef(0);
  const resizingRef = useRef(false);

  const showNotice = useCallback((kind: 'info' | 'error', text: string) => {
    setBannerNotice({ kind, text });
    setTimeout(() => {
      setBannerNotice((curr) => (curr?.text === text ? null : curr));
    }, 3500);
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Fetch initial directory
  useEffect(() => {
    client
      .getInfo()
      .then((wsInfo) => {
        setCurrentDir((prev) => prev || wsInfo.defaultPath);
      })
      .catch((err) => {
        showNotice('error', err instanceof Error ? err.message : 'Failed to load workspace info');
      });
  }, [client, showNotice]);

  const loadDirectory = useCallback(
    async (dirToLoad: string) => {
      if (!dirToLoad) return;
      setLoadingList(true);
      try {
        const listRes = await client.listDir(dirToLoad, showHidden);
        setEntries(listRes.entries);
        setParentDir(listRes.parent);
        setBreadcrumbs(listRes.breadcrumbs);
        setSelectedPaths(new Set());
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : 'Failed to list directory');
      } finally {
        setLoadingList(false);
      }
    },
    [client, showHidden, showNotice]
  );

  useEffect(() => {
    if (currentDir) {
      void loadDirectory(currentDir);
    }
  }, [currentDir, loadDirectory]);

  // Terminal vertical resize handler
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(Math.max(window.innerHeight - e.clientY, 160), window.innerHeight - 200);
      setTerminalHeight(next);
    };
    const onUp = () => {
      resizingRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const syncAfterMutation = useCallback(async () => {
    setTreeRefreshNonce((n) => n + 1);
    if (currentDir) {
      await loadDirectory(currentDir);
    }
  }, [currentDir, loadDirectory]);

  const handleSelectDir = useCallback((dirPath: string) => {
    setCurrentDir(dirPath);
    setSearchFilter('');
    setCenterView('directory');
  }, []);

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      setCenterView('editor');
      setActiveFilePath(filePath);
      if (layoutView === 'terminal') {
        setLayoutView('split');
      }

      const existing = openTabs.find((t) => t.path === filePath);
      if (existing) return;

      const placeholder: OpenFileTab = {
        path: filePath,
        name: getBasename(filePath),
        content: '',
        savedContent: '',
        isBinary: false,
        isImage: false,
        tooLarge: false,
        size: 0,
        mtimeMs: 0,
        extension: '',
        loading: true,
      };
      setOpenTabs((prev) => [...prev, placeholder]);

      try {
        const res = await client.readFile(filePath);
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.path === filePath
              ? {
                  ...res,
                  savedContent: res.content,
                  loading: false,
                }
              : t
          )
        );
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : 'Failed to open file');
        setOpenTabs((prev) => prev.filter((t) => t.path !== filePath));
      }
    },
    [client, layoutView, openTabs, showNotice]
  );

  const handleCloseTab = (path: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activeFilePath === path) {
        const fallback = next[next.length - 1]?.path || null;
        setActiveFilePath(fallback);
        if (!fallback) setCenterView('directory');
      }
      return next;
    });
  };

  const handleChangeFileContent = (path: string, content: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, content } : t)));
  };

  const handleSaveFile = async (path: string) => {
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      const res = await client.writeFile(path, tab.content);
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.path === path ? { ...t, savedContent: tab.content, size: res.size, mtimeMs: res.mtimeMs } : t
        )
      );
      showNotice('info', `Saved ${tab.name}`);
      void syncAfterMutation();
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to save file');
    }
  };

  const handleUploadBatch = async (files: File[], relativePaths?: string[]) => {
    if (files.length === 0 || !currentDir) return;
    setUploadProgress(0);
    try {
      const res = await client.uploadFiles(files, currentDir, relativePaths, (pct) => setUploadProgress(pct));
      showNotice('info', `Uploaded ${res.uploaded.length} item(s) to ${currentDir}`);
      await syncAfterMutation();
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadProgress(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const collected = await collectDroppedItems(e.dataTransfer);
    if (collected.length > 0) {
      await handleUploadBatch(
        collected.map((c) => c.file),
        collected.map((c) => c.relativePath)
      );
    }
  };

  const handleDialogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialog) return;

    try {
      if (dialog.kind === 'new-file') {
        const clean = dialog.value.trim();
        if (!clean) return;
        const target = joinPosixPath(dialog.baseDir, clean);
        await client.writeFile(target, '');
        setDialog(null);
        await syncAfterMutation();
        await handleOpenFile(target);
      } else if (dialog.kind === 'new-folder') {
        const clean = dialog.value.trim();
        if (!clean) return;
        const target = joinPosixPath(dialog.baseDir, clean);
        await client.mkdir(target);
        setDialog(null);
        await syncAfterMutation();
      } else if (dialog.kind === 'rename') {
        const clean = dialog.value.trim();
        if (!clean || clean === dialog.entry.name) {
          setDialog(null);
          return;
        }
        const parent = getParentPath(dialog.entry.path);
        const newPath = joinPosixPath(parent, clean);
        await client.rename(dialog.entry.path, newPath);
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.path === dialog.entry.path ? { ...t, path: newPath, name: getBasename(newPath) } : t
          )
        );
        if (activeFilePath === dialog.entry.path) {
          setActiveFilePath(newPath);
        }
        setDialog(null);
        await syncAfterMutation();
      } else if (dialog.kind === 'delete') {
        for (const p of dialog.paths) {
          await client.deletePath(p);
          setOpenTabs((prev) => prev.filter((t) => t.path !== p && !t.path.startsWith(`${p}/`)));
        }
        setDialog(null);
        showNotice('info', `Deleted ${dialog.paths.length} item(s)`);
        await syncAfterMutation();
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Operation failed');
    }
  };

  const filteredEntries = useMemo(() => {
    if (!searchFilter.trim()) return entries;
    const q = searchFilter.toLowerCase();
    return entries.filter((item) => item.name.toLowerCase().includes(q));
  }, [entries, searchFilter]);

  const toggleSelectEntry = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedPaths.size === filteredEntries.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(filteredEntries.map((e) => e.path)));
    }
  };

  const renderWorkspace = () => {
    return (
      <div
        className="relative flex flex-col flex-1 min-h-0 bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100"
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounterRef.current += 1;
          setIsDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragCounterRef.current -= 1;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragging(false);
          }
        }}
        onDrop={(e) => void handleDrop(e)}
      >
        {/* Top Bar Contract: 3 zones (Wordmark — Nav Links — 1 Primary Action) */}
        <header className="flex items-center justify-between gap-8 px-5 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131D] shrink-0">
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            Sandbox Studio
          </span>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setLayoutView('split')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors ${
                layoutView === 'split'
                  ? 'text-sky-600 dark:text-sky-400 border-b-2 border-sky-500'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Split
            </button>
            <button
              type="button"
              onClick={() => setLayoutView('explorer')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors ${
                layoutView === 'explorer'
                  ? 'text-sky-600 dark:text-sky-400 border-b-2 border-sky-500'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Files
            </button>
            <button
              type="button"
              onClick={() => setLayoutView('terminal')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors ${
                layoutView === 'terminal'
                  ? 'text-sky-600 dark:text-sky-400 border-b-2 border-sky-500'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Terminal
            </button>
          </nav>

          {/* Unified Upload CTA (supports both files & recursive folders) */}
          <div className="flex items-center gap-2 shrink-0" ref={uploadMenuRef}>
            <div className="relative">
              <button
                type="button"
                onClick={() => setUploadMenuOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white whitespace-nowrap shrink-0 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-80" />
              </button>

              {uploadMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-48 py-1 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-700 shadow-xl z-30">
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    Upload Files...
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuOpen(false);
                      folderInputRef.current?.click();
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    Upload Folder (recursive)...
                  </button>
                </div>
              )}
            </div>

            {mode === 'drawer' && (
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                aria-label="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </header>

        {/* Hidden native inputs for unified Upload menu */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            void handleUploadBatch(files);
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            const rels = files.map(
              (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
            );
            e.target.value = '';
            void handleUploadBatch(files, rels);
          }}
        />

        {/* Workspace Toolbar (only shown when explorer is visible) */}
        {layoutView !== 'terminal' && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#0B0F17] shrink-0">
            {/* Left: Up-level + Breadcrumbs + View Switch */}
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                disabled={!parentDir}
                onClick={() => parentDir && handleSelectDir(parentDir)}
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                title="Parent directory"
                aria-label="Parent directory"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>

              <div className="flex items-center gap-1 text-xs font-mono overflow-x-auto sandbox-scroll">
                {breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <React.Fragment key={crumb.path}>
                      {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                      <button
                        type="button"
                        onClick={() => handleSelectDir(crumb.path)}
                        className={`px-1.5 py-0.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap ${
                          isLast && centerView === 'directory'
                            ? 'text-sky-600 dark:text-sky-400 font-semibold'
                            : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {crumb.name}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              {openTabs.length > 0 && (
                <div className="hidden sm:flex items-center gap-1 ml-2 p-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setCenterView('directory')}
                    className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                      centerView === 'directory'
                        ? 'bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    Files
                  </button>
                  <button
                    type="button"
                    onClick={() => setCenterView('editor')}
                    className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                      centerView === 'editor'
                        ? 'bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    Open ({openTabs.length})
                  </button>
                </div>
              )}
            </div>

            {/* Right: Filter, New File, New Folder, Download ZIP, Theme */}
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative hidden lg:flex items-center mr-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
                <input
                  type="text"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Filter..."
                  className="w-36 pl-7 pr-6 py-1 text-xs rounded-md bg-white dark:bg-[#131A26] border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500"
                />
                {searchFilter && (
                  <button
                    type="button"
                    onClick={() => setSearchFilter('')}
                    className="absolute right-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    aria-label="Clear filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setDialog({ kind: 'new-file', baseDir: currentDir, value: '' })}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
              >
                <FilePlus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New File</span>
              </button>

              <button
                type="button"
                onClick={() => setDialog({ kind: 'new-folder', baseDir: currentDir, value: '' })}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Folder</span>
              </button>

              <a
                href={client.getDownloadZipUrl([currentDir || '/app/applet'])}
                download
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-white dark:bg-[#131A26] border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
                title="Download current directory as ZIP"
              >
                <FolderArchive className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                <span>Download ZIP</span>
              </a>

              <button
                type="button"
                onClick={toggleTheme}
                className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                title={isDark ? 'Light theme' : 'Dark theme'}
                aria-label="Toggle theme"
              >
                {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )}

        {/* Upload progress or status notice */}
        {(uploadProgress !== null || bannerNotice) && (
          <div className="px-4 py-1.5 text-xs border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0E131D] flex items-center justify-between gap-3 shrink-0">
            {uploadProgress !== null ? (
              <div className="flex items-center gap-3 w-full">
                <span className="text-sky-600 dark:text-sky-400 font-medium whitespace-nowrap">
                  Uploading...
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all duration-150"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <span className="font-mono tabular-nums text-slate-500">{uploadProgress}%</span>
              </div>
            ) : bannerNotice ? (
              <>
                <span
                  className={
                    bannerNotice.kind === 'error'
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }
                >
                  {bannerNotice.text}
                </span>
                <button
                  type="button"
                  onClick={() => setBannerNotice(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : null}
          </div>
        )}

        {/* Main Workspace Split */}
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Upper Area: Sidebar Tree + File List/Editor */}
          {layoutView !== 'terminal' && (
            <div className="flex-1 min-h-0 flex overflow-hidden">
              <div className="hidden md:block w-[250px] shrink-0 h-full">
                <FileTree
                  client={client}
                  currentDir={currentDir}
                  showHidden={showHidden}
                  refreshNonce={treeRefreshNonce}
                  onToggleHidden={() => setShowHidden((v) => !v)}
                  onSelectDir={handleSelectDir}
                />
              </div>

              <main className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-white dark:bg-[#0B0F17]">
                {centerView === 'editor' && openTabs.length > 0 ? (
                  <FilePreviewEditor
                    tabs={openTabs}
                    activePath={activeFilePath}
                    rawUrlBuilder={(p) => client.getRawUrl(p)}
                    downloadUrlBuilder={(p) => client.getDownloadUrl(p)}
                    onSelectTab={(p) => setActiveFilePath(p)}
                    onCloseTab={handleCloseTab}
                    onChangeContent={handleChangeFileContent}
                    onSaveFile={handleSaveFile}
                  />
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/* Batch Selection Toolbar */}
                    {selectedPaths.size > 0 && (
                      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-sky-500/10 border-b border-sky-500/20 text-xs">
                        <span className="font-medium text-sky-700 dark:text-sky-300 tabular-nums">
                          {selectedPaths.size} selected
                        </span>
                        <div className="flex items-center gap-2">
                          <a
                            href={client.getDownloadZipUrl(Array.from(selectedPaths))}
                            download
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium whitespace-nowrap"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download ZIP</span>
                          </a>
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'delete', paths: Array.from(selectedPaths) })}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-medium whitespace-nowrap"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedPaths(new Set())}
                            className="px-2 py-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Directory Table */}
                    <div className="flex-1 overflow-auto sandbox-scroll">
                      {loadingList ? (
                        <div className="p-4 space-y-2">
                          {Array.from({ length: 8 }).map((_, idx) => (
                            <div
                              key={idx}
                              className="h-9 rounded bg-slate-100 dark:bg-slate-800/50 animate-pulse"
                            />
                          ))}
                        </div>
                      ) : filteredEntries.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                          <Folder className="w-10 h-10 text-slate-300 dark:text-slate-700 mb-3" />
                          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            {searchFilter ? 'No matching files or folders' : 'Empty directory'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Drag and drop files or folders here to upload, or create a new file.
                          </p>
                          <div className="mt-4 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="px-3 py-1.5 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white"
                            >
                              Upload Files
                            </button>
                            <button
                              type="button"
                              onClick={() => setDialog({ kind: 'new-file', baseDir: currentDir, value: '' })}
                              className="px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              New File
                            </button>
                          </div>
                        </div>
                      ) : (
                        <table className="w-full text-left border-collapse">
                          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-[#0E131D] border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                            <tr>
                              <th className="w-9 pl-4 pr-2 py-2.5">
                                <button
                                  type="button"
                                  onClick={toggleSelectAll}
                                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                  aria-label="Select all"
                                >
                                  {selectedPaths.size === filteredEntries.length && filteredEntries.length > 0 ? (
                                    <CheckSquare className="w-3.5 h-3.5 text-sky-500" />
                                  ) : (
                                    <Square className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </th>
                              <th className="py-2.5 pr-3">Name</th>
                              <th className="py-2.5 px-3 w-24 text-right">Size</th>
                              <th className="py-2.5 px-3 w-36 text-right hidden md:table-cell">Modified</th>
                              <th className="py-2.5 pl-3 pr-4 w-28 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-[13px]">
                            {filteredEntries.map((entry) => {
                              const isChecked = selectedPaths.has(entry.path);
                              const isDir = entry.type === 'dir';
                              const isSymlink = entry.type === 'symlink';
                              return (
                                <tr
                                  key={entry.path}
                                  className={`group h-10 transition-colors ${
                                    isChecked
                                      ? 'bg-sky-500/8'
                                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                                  }`}
                                >
                                  <td className="pl-4 pr-2">
                                    <button
                                      type="button"
                                      onClick={() => toggleSelectEntry(entry.path)}
                                      className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                      aria-label={`Select ${entry.name}`}
                                    >
                                      {isChecked ? (
                                        <CheckSquare className="w-3.5 h-3.5 text-sky-500" />
                                      ) : (
                                        <Square className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  </td>
                                  <td className="pr-3 max-w-xs">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        isDir ? handleSelectDir(entry.path) : void handleOpenFile(entry.path)
                                      }
                                      className="flex items-center gap-2 w-full text-left font-medium text-slate-800 dark:text-slate-200 hover:text-sky-600 dark:hover:text-sky-400"
                                    >
                                      {isDir ? (
                                        <Folder className="w-4 h-4 text-sky-500 shrink-0" />
                                      ) : isSymlink ? (
                                        <Link2 className="w-4 h-4 text-amber-500 shrink-0" />
                                      ) : (
                                        <FileIcon className="w-4 h-4 text-slate-400 shrink-0" />
                                      )}
                                      <span className="truncate">{entry.name}</span>
                                      {entry.linkTarget && (
                                        <span className="text-[11px] font-mono text-slate-400 truncate hidden sm:inline">
                                          → {entry.linkTarget}
                                        </span>
                                      )}
                                    </button>
                                  </td>
                                  <td className="px-3 text-right text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                                    {isDir ? '—' : formatBytes(entry.size)}
                                  </td>
                                  <td className="px-3 text-right text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums hidden md:table-cell">
                                    {formatTimestamp(entry.mtimeMs)}
                                  </td>
                                  <td className="pl-3 pr-4 text-right">
                                    <div className="inline-flex items-center gap-1 opacity-75 group-hover:opacity-100">
                                      {isDir ? (
                                        <a
                                          href={client.getDownloadZipUrl([entry.path])}
                                          download
                                          className="p-1.5 rounded text-slate-500 hover:text-sky-500 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                                          title="Download directory as ZIP"
                                          aria-label="Download directory as ZIP"
                                        >
                                          <Download className="w-3.5 h-3.5" />
                                        </a>
                                      ) : (
                                        <a
                                          href={client.getDownloadUrl(entry.path)}
                                          download={entry.name}
                                          className="p-1.5 rounded text-slate-500 hover:text-sky-500 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                                          title="Download file"
                                          aria-label="Download file"
                                        >
                                          <Download className="w-3.5 h-3.5" />
                                        </a>
                                      )}

                                      <button
                                        type="button"
                                        onClick={() =>
                                          setDialog({ kind: 'rename', entry, value: entry.name })
                                        }
                                        className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                                        title="Rename"
                                        aria-label="Rename"
                                      >
                                        <Pencil className="w-3.5 h-3.5" />
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() => setDialog({ kind: 'delete', paths: [entry.path] })}
                                        className="p-1.5 rounded text-slate-500 hover:text-rose-500 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                                        title="Delete"
                                        aria-label="Delete"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )}
              </main>
            </div>
          )}

          {/* Resize Handle (Split Mode) */}
          {layoutView === 'split' && !terminalMaximized && (
            <div
              onMouseDown={() => {
                resizingRef.current = true;
              }}
              className="h-1.5 bg-slate-200/70 dark:bg-slate-800/80 hover:bg-sky-500/60 cursor-row-resize transition-colors shrink-0"
              title="Drag to resize terminal"
            />
          )}

          {/* Terminal Window */}
          {layoutView !== 'explorer' && (
            <div
              style={
                layoutView === 'terminal' || terminalMaximized
                  ? { flex: '1 1 0%', minHeight: 0 }
                  : { height: `${terminalHeight}px`, flexShrink: 0 }
              }
              className="min-h-0"
            >
              <TerminalPane
                client={client}
                currentDir={currentDir || '/app/applet'}
                isMaximized={terminalMaximized}
                onToggleMaximize={() => setTerminalMaximized((v) => !v)}
              />
            </div>
          )}
        </div>

        {/* Drag-and-Drop Overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-sky-950/75 backdrop-blur-xs border-2 border-dashed border-sky-400 m-2 rounded-xl pointer-events-none">
            <div className="text-center text-white">
              <Upload className="w-10 h-10 mx-auto mb-2 text-sky-300" />
              <p className="text-base font-semibold">Drop files or folders to upload</p>
              <p className="mt-1 text-xs text-sky-200 font-mono">Destination: {currentDir}</p>
            </div>
          </div>
        )}

        {/* Inline Action Modal (Create / Rename / Delete) */}
        {dialog && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
            onClick={() => setDialog(null)}
          >
            <form
              onSubmit={(e) => void handleDialogSubmit(e)}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md p-5 rounded-xl bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4"
            >
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {dialog.kind === 'new-file' && 'New File'}
                {dialog.kind === 'new-folder' && 'New Folder'}
                {dialog.kind === 'rename' && `Rename: ${dialog.entry.name}`}
                {dialog.kind === 'delete' && `Confirm Delete (${dialog.paths.length})`}
              </h3>

              {dialog.kind === 'delete' ? (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    The following item(s) will be permanently deleted:
                  </p>
                  <div className="max-h-36 overflow-y-auto p-2.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 font-mono text-xs text-rose-600 dark:text-rose-400 space-y-1">
                    {dialog.paths.map((p) => (
                      <div key={p} className="truncate">
                        {p}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-xs text-slate-500 dark:text-slate-400 font-mono">
                    {dialog.kind === 'rename' ? 'New name' : `Directory: ${dialog.baseDir}`}
                  </label>
                  <input
                    type="text"
                    value={dialog.value}
                    onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                    placeholder={
                      dialog.kind === 'new-file'
                        ? 'e.g. helper.ts'
                        : dialog.kind === 'new-folder'
                          ? 'e.g. logs'
                          : 'New name'
                    }
                    autoFocus
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium text-white ${
                    dialog.kind === 'delete'
                      ? 'bg-rose-600 hover:bg-rose-500'
                      : 'bg-sky-600 hover:bg-sky-500'
                  }`}
                >
                  {dialog.kind === 'delete' ? 'Delete' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    );
  };

  if (mode === 'drawer') {
    return (
      <>
        {!drawerOpen && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-sky-600 text-white text-xs font-semibold shadow-xl border border-slate-700 dark:border-sky-500 hover:brightness-110 transition-all"
          >
            <TerminalIcon className="w-4 h-4" />
            <span>Sandbox</span>
          </button>
        )}

        {drawerOpen && (
          <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/50 backdrop-blur-[1px]">
            <div className="h-[82vh] w-full flex flex-col border-t border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
              {renderWorkspace()}
            </div>
          </div>
        )}
      </>
    );
  }

  return <div className="h-screen w-screen flex flex-col overflow-hidden">{renderWorkspace()}</div>;
};
