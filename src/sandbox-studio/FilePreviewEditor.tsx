import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Eye,
  FileCode2,
  RotateCcw,
  Save,
  WrapText,
  X,
} from 'lucide-react';
import { OpenFileTab } from './types';
import { formatBytes, formatTimestamp } from './utils';

interface FilePreviewEditorProps {
  tabs: OpenFileTab[];
  activePath: string | null;
  rawUrlBuilder: (relPath: string) => string;
  downloadUrlBuilder: (relPath: string) => string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChangeContent: (path: string, content: string) => void;
  onSaveFile: (path: string) => Promise<void>;
  onRevertFile: (path: string) => void;
}

function renderSafeMarkdown(source: string): React.ReactNode {
  const lines = source.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const flushCode = (key: string) => {
    elements.push(
      <pre
        key={key}
        className="my-3 p-3 rounded-lg bg-slate-900 text-slate-100 border border-slate-800 text-xs font-mono overflow-x-auto"
      >
        <code>{codeLines.join('\n')}</code>
      </pre>
    );
    codeLines = [];
  };

  lines.forEach((line, idx) => {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        flushCode(`code-${idx}`);
      } else {
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={idx} className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-4 mb-2">
          {line.slice(2)}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={idx} className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-4 mb-2">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={idx} className="text-base font-semibold text-slate-800 dark:text-slate-200 mt-3 mb-1">
          {line.slice(4)}
        </h3>
      );
    } else if (line.trim().startsWith('- ')) {
      elements.push(
        <li key={idx} className="ml-5 list-disc text-sm text-slate-700 dark:text-slate-300 leading-6">
          {line.trim().slice(2)}
        </li>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={idx} className="h-2" />);
    } else {
      elements.push(
        <p key={idx} className="text-sm text-slate-700 dark:text-slate-300 leading-6">
          {line}
        </p>
      );
    }
  });

  if (inCodeBlock && codeLines.length > 0) {
    flushCode('code-end');
  }

  return <div className="max-w-3xl mx-auto px-6 py-5">{elements}</div>;
}

export const FilePreviewEditor: React.FC<FilePreviewEditorProps> = ({
  tabs,
  activePath,
  rawUrlBuilder,
  downloadUrlBuilder,
  onSelectTab,
  onCloseTab,
  onChangeContent,
  onSaveFile,
  onRevertFile,
}) => {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState(false);

  const activeTab = tabs.find((t) => t.path === activePath) || null;
  const isDirty = activeTab ? activeTab.content !== activeTab.savedContent : false;

  useEffect(() => {
    setMarkdownPreview(false);
  }, [activePath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && activeTab && !activeTab.isBinary) {
        e.preventDefault();
        if (activeTab.content !== activeTab.savedContent && !saving) {
          setSaving(true);
          onSaveFile(activeTab.path).finally(() => setSaving(false));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, saving, onSaveFile]);

  if (tabs.length === 0 || !activeTab) {
    return null;
  }

  const lineCount = activeTab.content ? activeTab.content.split('\n').length : 1;

  const handleSave = async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      await onSaveFile(activeTab.path);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!activeTab.content) return;
    await navigator.clipboard.writeText(activeTab.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0B0F17]">
      {/* Open Tabs Strip */}
      <div className="flex items-center overflow-x-auto border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0E131D] sandbox-scroll">
        {tabs.map((tab) => {
          const tabDirty = tab.content !== tab.savedContent;
          const isSelected = tab.path === activeTab.path;
          return (
            <div
              key={tab.path}
              className={`group flex items-center gap-2 px-3 py-2 text-xs border-r border-slate-200 dark:border-slate-800 shrink-0 cursor-pointer transition-colors ${
                isSelected
                  ? 'bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 font-medium border-b-2 border-b-sky-500'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50'
              }`}
              onClick={() => onSelectTab(tab.path)}
              title={tab.path}
            >
              <span className="truncate max-w-[160px]">{tab.name}</span>
              {tabDirty && (
                <span className="text-amber-500 font-mono text-[11px]" title="未保存更改">
                  *
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.path);
                }}
                className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/60"
                aria-label={`关闭 ${tab.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* File Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17]">
        <div className="flex items-center gap-2 min-w-0 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-mono text-slate-800 dark:text-slate-200 truncate">{activeTab.path}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums whitespace-nowrap">{formatBytes(activeTab.size)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums whitespace-nowrap hidden sm:inline">
            {formatTimestamp(activeTab.mtimeMs)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!activeTab.isBinary && !activeTab.isImage && (
            <>
              {activeTab.extension === '.md' && (
                <button
                  type="button"
                  onClick={() => setMarkdownPreview((v) => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                    markdownPreview
                      ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {markdownPreview ? <FileCode2 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>{markdownPreview ? '源码' : '预览'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setWordWrap((w) => !w)}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
                  wordWrap
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
                title="自动换行"
              >
                <WrapText className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
                title="复制文件内容"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>

              {isDirty && (
                <button
                  type="button"
                  onClick={() => onRevertFile(activeTab.path)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
                  title="撤销未保存修改"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>撤销</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || saving}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  isDirty
                    ? 'bg-sky-600 hover:bg-sky-500 text-white'
                    : 'bg-slate-100 dark:bg-slate-800/80 text-slate-400 cursor-not-allowed'
                }`}
                title="保存文件 (Ctrl+S / Cmd+S)"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? '保存中...' : '保存'}</span>
              </button>
            </>
          )}

          <a
            href={downloadUrlBuilder(activeTab.path)}
            download={activeTab.name}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载</span>
          </a>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab.loading ? (
          <div className="p-6 space-y-2">
            <div className="h-4 w-2/3 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
            <div className="h-4 w-1/2 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
            <div className="h-4 w-3/4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
          </div>
        ) : activeTab.isImage ? (
          <div className="h-full flex flex-col items-center justify-center p-6 bg-slate-100/70 dark:bg-[#090D14] overflow-auto">
            <img
              src={rawUrlBuilder(activeTab.path)}
              alt={activeTab.name}
              referrerPolicy="no-referrer"
              className="max-w-full max-h-[70vh] object-contain rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            />
            <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 font-mono">
              {activeTab.name} · {formatBytes(activeTab.size)}
            </div>
          </div>
        ) : activeTab.isBinary || activeTab.tooLarge ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {activeTab.tooLarge ? '文件超过 2 MB 文本预览限制' : '二进制文件不支持文本编辑'}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {activeTab.name} · {formatBytes(activeTab.size)}
            </p>
            <a
              href={downloadUrlBuilder(activeTab.path)}
              download={activeTab.name}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载到本地查看</span>
            </a>
          </div>
        ) : markdownPreview && activeTab.extension === '.md' ? (
          <div className="h-full overflow-y-auto sandbox-scroll">{renderSafeMarkdown(activeTab.content)}</div>
        ) : (
          <div className="h-full flex overflow-auto sandbox-scroll font-mono text-[13px] leading-6">
            {/* Line numbers gutter */}
            <div
              className="py-3 px-3 text-right select-none text-slate-400 dark:text-slate-600 bg-slate-50/80 dark:bg-[#0E131D] border-r border-slate-200/80 dark:border-slate-800/80 tabular-nums shrink-0"
              aria-hidden="true"
            >
              {Array.from({ length: lineCount }, (_, idx) => (
                <div key={idx}>{idx + 1}</div>
              ))}
            </div>

            {/* Editable code textarea */}
            <textarea
              value={activeTab.content}
              onChange={(e) => onChangeContent(activeTab.path, e.target.value)}
              spellCheck={false}
              wrap={wordWrap ? 'soft' : 'off'}
              className="flex-1 min-w-0 min-h-full p-3 bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none resize-none font-mono text-[13px] leading-6"
            />
          </div>
        )}
      </div>
    </div>
  );
};
