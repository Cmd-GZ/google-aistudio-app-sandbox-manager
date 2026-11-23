import React, { useEffect, useState } from 'react';
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  RefreshCw,
} from 'lucide-react';
import { SandboxClient } from './api';
import { BookmarkItem, DirChildItem } from './types';

interface FileTreeProps {
  client: SandboxClient;
  currentDir: string;
  bookmarks: BookmarkItem[];
  allowedRoots: string[];
  showHidden: boolean;
  refreshNonce: number;
  onToggleHidden: () => void;
  onRefresh: () => void;
  onSelectDir: (dirPath: string) => void;
  onCreateFile: (inDir: string) => void;
  onCreateFolder: (inDir: string) => void;
}

interface TreeBranchProps {
  client: SandboxClient;
  name: string;
  dirPath: string;
  depth: number;
  currentDir: string;
  showHidden: boolean;
  refreshNonce: number;
  onSelectDir: (dirPath: string) => void;
}

const TreeBranch: React.FC<TreeBranchProps> = ({
  client,
  name,
  dirPath,
  depth,
  currentDir,
  showHidden,
  refreshNonce,
  onSelectDir,
}) => {
  const isAncestor =
    dirPath === '/'
      ? currentDir.startsWith('/')
      : currentDir === dirPath || currentDir.startsWith(`${dirPath}/`);

  const [expanded, setExpanded] = useState(dirPath === '/' || isAncestor);
  const [children, setChildren] = useState<DirChildItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const isActive = currentDir === dirPath;

  const fetchChildren = async () => {
    setLoading(true);
    try {
      const res = await client.getTreeDirs(dirPath, showHidden);
      setChildren(res.dirs);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded) {
      void fetchChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden, refreshNonce]);

  useEffect(() => {
    if (isAncestor && !expanded) {
      setExpanded(true);
    }
  }, [isAncestor, expanded]);

  useEffect(() => {
    if (expanded && children === null) {
      void fetchChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      void fetchChildren();
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelectDir(dirPath)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectDir(dirPath);
          }
        }}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className={`flex items-center gap-1.5 pr-2 py-1.5 text-xs rounded-md cursor-pointer transition-colors select-none ${
          isActive
            ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 font-medium'
            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70'
        }`}
        title={dirPath}
      >
        <button
          type="button"
          onClick={toggleExpand}
          aria-label={expanded ? `折叠 ${name}` : `展开 ${name}`}
          className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        {expanded || isActive ? (
          <FolderOpen className="w-3.5 h-3.5 text-sky-500 shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        )}
        <span className="truncate font-mono">{name}</span>
      </div>

      {expanded && (
        <div>
          {loading && children === null ? (
            <div
              style={{ paddingLeft: `${26 + depth * 12}px` }}
              className="py-1 text-[11px] text-slate-400"
            >
              加载中...
            </div>
          ) : (
            (children || []).map((child) => (
              <TreeBranch
                key={child.path}
                client={client}
                name={child.name}
                dirPath={child.path}
                depth={depth + 1}
                currentDir={currentDir}
                showHidden={showHidden}
                refreshNonce={refreshNonce}
                onSelectDir={onSelectDir}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({
  client,
  currentDir,
  bookmarks,
  allowedRoots,
  showHidden,
  refreshNonce,
  onToggleHidden,
  onRefresh,
  onSelectDir,
  onCreateFile,
  onCreateFolder,
}) => {
  return (
    <aside className="flex flex-col h-full bg-slate-100/70 dark:bg-[#0E131D] border-r border-slate-200 dark:border-slate-800 select-none">
      {/* Sidebar Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
          沙箱目录
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => onCreateFile(currentDir)}
            className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
            title="新建文件"
            aria-label="新建文件"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onCreateFolder(currentDir)}
            className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
            title="新建文件夹"
            aria-label="新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleHidden}
            className={`p-1.5 rounded transition-colors ${
              showHidden
                ? 'text-sky-600 dark:text-sky-400 bg-sky-500/10'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800'
            }`}
            title={showHidden ? '隐藏点文件' : '显示隐藏文件'}
            aria-label="切换隐藏文件显示"
          >
            {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
            title="刷新目录树"
            aria-label="刷新目录树"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-4 sandbox-scroll">
        {/* Bookmarks */}
        {bookmarks.length > 0 && (
          <div>
            <div className="px-2 pb-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              常用目录
            </div>
            <div className="space-y-0.5">
              {bookmarks.map((bm) => {
                const active = currentDir === bm.path;
                return (
                  <button
                    key={bm.path}
                    type="button"
                    onClick={() => onSelectDir(bm.path)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-md transition-colors text-left ${
                      active
                        ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70'
                    }`}
                    title={bm.path}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Bookmark className="w-3.5 h-3.5 shrink-0 opacity-75" />
                      <span className="truncate">{bm.label}</span>
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 truncate max-w-[90px]">
                      {bm.path}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Lazy Directory Tree */}
        <div className="border-t border-slate-200/80 dark:border-slate-800 pt-3">
          <div className="px-2 pb-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
            <HardDrive className="w-3 h-3" />
            <span>目录树</span>
          </div>
          <div className="space-y-0.5">
            {allowedRoots.map((root) => (
              <TreeBranch
                key={root}
                client={client}
                name={root}
                dirPath={root}
                depth={0}
                currentDir={currentDir}
                showHidden={showHidden}
                refreshNonce={refreshNonce}
                onSelectDir={onSelectDir}
              />
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};
