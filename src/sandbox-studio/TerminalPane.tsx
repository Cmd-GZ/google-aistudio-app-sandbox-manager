import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Maximize2, Minimize2, Plus, RotateCcw, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { SandboxClient } from './api';
import { TerminalSessionInfo } from './types';
import { base64ToBytes } from './utils';

interface TerminalPaneProps {
  client: SandboxClient;
  currentDir: string;
  pendingOpenCwd?: { path: string; nonce: number } | null;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onFilesystemChanged?: () => void;
}

const XTermInstance: React.FC<{
  client: SandboxClient;
  sessionId: string;
  visible: boolean;
  onExited: (id: string, code: number) => void;
}> = ({ client, sessionId, visible, onExited }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.35,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 5000,
      theme: {
        background: '#0A0E15',
        foreground: '#E2E8F0',
        cursor: '#38BDF8',
        selectionBackground: '#334155',
        black: '#1E293B',
        red: '#F87171',
        green: '#4ADE80',
        yellow: '#FBBF24',
        blue: '#60A5FA',
        magenta: '#C084FC',
        cyan: '#22D3EE',
        white: '#F1F5F9',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current = fitAddon;

    const syncResize = () => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols > 0 && rows > 0 && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
          lastSizeRef.current = { cols, rows };
          client.resizeTerminal(sessionId, cols, rows).catch(() => {});
        }
      } catch {
        // Ignore resize before layout ready
      }
    };

    const inputDisposable = term.onData((data) => {
      client.sendTerminalInput(sessionId, data).catch(() => {});
    });

    const es = new EventSource(client.getTerminalStreamUrl(sessionId));
    es.addEventListener('replay', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        if (parsed.b64) {
          term.write(base64ToBytes(parsed.b64));
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener('data', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        if (parsed.b64) {
          term.write(base64ToBytes(parsed.b64));
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener('exit', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        const code = typeof parsed.exitCode === 'number' ? parsed.exitCode : 0;
        term.writeln(`\r\n[进程已退出，退出码 ${code}]`);
        onExitedRef.current(sessionId, code);
      } catch {
        // ignore
      }
    });

    const observer = new ResizeObserver(() => {
      syncResize();
    });
    observer.observe(el);
    setTimeout(syncResize, 50);

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      es.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [client, sessionId]);

  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
          const cols = termRef.current?.cols || 100;
          const rows = termRef.current?.rows || 28;
          if (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows) {
            lastSizeRef.current = { cols, rows };
            client.resizeTerminal(sessionId, cols, rows).catch(() => {});
          }
          termRef.current?.focus();
        } catch {
          // ignore
        }
      }, 30);
    }
  }, [client, visible, sessionId]);

  return (
    <div
      ref={containerRef}
      onClick={() => termRef.current?.focus()}
      className={visible ? 'w-full h-full px-2.5 py-2' : 'hidden'}
    />
  );
};

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  client,
  currentDir,
  pendingOpenCwd,
  isMaximized = false,
  onToggleMaximize,
  onFilesystemChanged,
}) => {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const handleNewSession = useCallback(
    async (cwd: string) => {
      setCreating(true);
      setErrorMsg(null);
      try {
        const info = await client.createTerminalSession(cwd || '/app/applet', 100, 26);
        setSessions((prev) => [...prev, info]);
        setActiveSessionId(info.id);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '启动终端失败');
      } finally {
        setCreating(false);
      }
    },
    [client]
  );

  // Sync existing sessions or spawn first bash PTY on mount
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    client
      .listTerminalSessions()
      .then((res) => {
        const aliveList = res.sessions.filter((s) => s.alive);
        if (aliveList.length > 0) {
          setSessions(aliveList);
          setActiveSessionId(aliveList[0].id);
        } else {
          void handleNewSession(currentDir);
        }
      })
      .catch(() => {
        void handleNewSession(currentDir);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (pendingOpenCwd) {
      void handleNewSession(pendingOpenCwd.path);
    }
  }, [pendingOpenCwd, handleNewSession]);

  const handleCloseSession = async (id: string) => {
    await client.closeTerminalSession(id).catch(() => {});
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeSessionId === id) {
        setActiveSessionId(next[next.length - 1]?.id || null);
      }
      return next;
    });
  };

  const handleClear = () => {
    if (!activeSessionId) return;
    client.sendTerminalInput(activeSessionId, '\x0c').catch(() => {});
  };

  const handleCdCurrent = () => {
    if (!activeSessionId || !currentDir) return;
    const escaped = `'${currentDir.replace(/'/g, `'\\''`)}'`;
    client.sendTerminalInput(activeSessionId, `cd ${escaped}\r`).catch(() => {});
    onFilesystemChanged?.();
  };

  const handleExited = useCallback((id: string, code: number) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, alive: false, exitCode: code } : s)));
  }, []);

  return (
    <section className="flex flex-col h-full bg-[#0A0E15] text-slate-100 border-t border-slate-200 dark:border-slate-800">
      {/* Terminal Tab Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#0F1520] border-b border-slate-800 select-none shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto sandbox-scroll min-w-0">
          <div className="flex items-center gap-1.5 pr-2 mr-1 border-r border-slate-800 text-xs font-medium text-slate-300 shrink-0">
            <TerminalIcon className="w-3.5 h-3.5 text-sky-400" />
            <span>终端</span>
          </div>

          {sessions.map((s, idx) => {
            const active = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono shrink-0 transition-colors ${
                  active
                    ? 'bg-slate-800 text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveSessionId(s.id)}
                  className="cursor-pointer whitespace-nowrap"
                >
                  bash-{idx + 1}
                  {!s.alive && ` (exit ${s.exitCode ?? 0})`}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCloseSession(s.id)}
                  className="p-0.5 rounded text-slate-500 hover:text-rose-400"
                  aria-label={`关闭终端 ${idx + 1}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            disabled={creating}
            onClick={() => void handleNewSession(currentDir)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-300 hover:text-white hover:bg-slate-800 shrink-0 transition-colors"
            title="新建 bash 终端"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">新建</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {activeSessionId && (
            <>
              <button
                type="button"
                onClick={handleCdCurrent}
                title={`切换到当前目录 (${currentDir})`}
                className="px-2.5 py-1 rounded text-[11px] font-medium border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white whitespace-nowrap transition-colors"
              >
                cd 到当前目录
              </button>
              <button
                type="button"
                onClick={handleClear}
                title="清屏 (Ctrl+L)"
                className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                aria-label="清屏"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleCloseSession(activeSessionId)}
                title="关闭当前终端"
                className="p-1.5 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
                aria-label="关闭当前终端"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {onToggleMaximize && (
            <button
              type="button"
              onClick={onToggleMaximize}
              className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={isMaximized ? '还原终端高度' : '最大化终端'}
              aria-label="切换终端最大化"
            >
              {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* XTerm Viewport */}
      <div className="flex-1 min-h-0 relative bg-[#0A0E15]">
        {errorMsg && (
          <div className="p-4 text-xs text-rose-400 font-mono">{errorMsg}</div>
        )}
        {sessions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-4 text-center">
            <p className="text-xs text-slate-400 mb-3">暂无活动终端会话</p>
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleNewSession(currentDir)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>启动 Bash 终端</span>
            </button>
          </div>
        ) : (
          sessions.map((s) => (
            <XTermInstance
              key={s.id}
              client={client}
              sessionId={s.id}
              visible={s.id === activeSessionId}
              onExited={handleExited}
            />
          ))
        )}
      </div>
    </section>
  );
};
