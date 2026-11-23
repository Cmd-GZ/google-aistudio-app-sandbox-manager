import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
} from 'lucide-react';
import { SandboxClient } from './api';
import { DirChildItem } from './types';

interface FileTreeProps {
  client: SandboxClient;
  currentDir: string;
  showHidden: boolean;
  refreshNonce: number;
  onToggleHidden: () => void;
  onSelectDir: (dirPath: string) => void;
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
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
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
              Loading...
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
  showHidden,
  refreshNonce,
  onToggleHidden,
  onSelectDir,
}) => {
  return (
    <aside className="flex flex-col h-full bg-slate-100/70 dark:bg-[#0E131D] border-r border-slate-200 dark:border-slate-800 select-none">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 truncate">
          Filesystem
        </span>
        <button
          type="button"
          onClick={onToggleHidden}
          className={`p-1 rounded transition-colors ${
            showHidden
              ? 'text-sky-600 dark:text-sky-400 bg-sky-500/10'
              : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800'
          }`}
          title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          aria-label="Toggle hidden files"
        >
          {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 sandbox-scroll">
        <TreeBranch
          client={client}
          name="/"
          dirPath="/"
          depth={0}
          currentDir={currentDir}
          showHidden={showHidden}
          refreshNonce={refreshNonce}
          onSelectDir={onSelectDir}
        />
      </div>
    </aside>
  );
};
