import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Link,
  Route,
  Switch,
  useLocation,
} from 'wouter';
import {
  ArrowUp,
  BookOpen,
  Bookmark,
  CalendarDays,
  Calculator,
  ChevronRight,
  Compass,
  ExternalLink,
  FileText,
  Grid2X2,
  Github,
  Languages,
  Lightbulb,
  ListTodo,
  MessageCircle,
  Mic,
  PenLine,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { GoogleGenAI, Modality } from '@google/genai';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

type Mode =
  | 'Ask'
  | 'Research'
  | 'Plan'
  | 'Create'
  | 'Explain'
  | 'Solve';

type Source = {
  title: string;
  url: string;
};

type UploadedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  text: string;
  fullText: string;
  canAnalyze?: boolean;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  files?: UploadedFile[];
  videoUrl?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
  saved: boolean;
};

type Preferences = {
  name: string;
  warm: boolean;
  concise: boolean;
  web: boolean;
};

type PluginId =
  | 'web-search'
  | 'code-interpreter'
  | 'file-analyzer'
  | 'calculator'
  | 'translator'
  | 'summarizer'
  | 'huggingface'
  | 'higgsfield-video'
  | 'github';
type AgentStep = {
  id: string;
  type:
    | 'status'
    | 'tool_call'
    | 'tool_result'
    | 'final'
    | 'error';
  message: string;
  tool?: string;
  ok?: boolean;
  timestamp: string;
};

type MemoryItem = {
  key: string;
  value: string;
};

type Plugin = {
  id: PluginId;
  name: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
  enabled: boolean;
  status: 'ready' | 'planned';
};

const PLUGIN_STORAGE_KEY = 'isabella-enabled-plugins';
const PLUGIN_VERSION_KEY = 'isabella-plugin-version';
const CURRENT_PLUGIN_VERSION = 4;

const availablePlugins: Plugin[] = [
  {
    id: 'web-search',
    name: 'Web Research',
    description: 'Search and inspect public web sources',
    icon: Search,
    enabled: true,
    status: 'ready',
  },
  {
    id: 'code-interpreter',
    name: 'Code Interpreter',
    description: 'Safe code execution is intentionally disabled',
    icon: Terminal,
    enabled: false,
    status: 'planned',
  },
  {
    id: 'file-analyzer',
    name: 'File Analyzer',
    description: 'Read and search uploaded documents and data',
    icon: FileText,
    enabled: true,
    status: 'ready',
  },
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Perform mathematical calculations',
    icon: Calculator,
    enabled: true,
    status: 'ready',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Specialist AI models and inference',
    icon: Sparkles,
    enabled: true,
    status: 'ready',
  },
  {
  id: 'higgsfield-video',
  name: 'Higgsfield Video',
  description:
    'Generate AI videos from text prompts',
  icon: Sparkles,
  enabled: true,
  status: 'ready',
},
  {
    id: 'github',
    name: 'GitHub',
    description: 'Search repositories, code, files, issues, and pull requests',
    icon: Github,
    enabled: true,
    status: 'ready',
  },
  {
    id: 'translator',
    name: 'Translator',
    description: 'Uses Isabella directly; no separate tool required',
    icon: Languages,
    enabled: false,
    status: 'planned',
  },
  {
    id: 'summarizer',
    name: 'Summarizer',
    description: 'Uses Isabella directly; no separate tool required',
    icon: FileText,
    enabled: false,
    status: 'planned',
  },
];

const queryClient = new QueryClient();

const navItems = [
  { href: '/', label: 'Chat', icon: MessageCircle },
  { href: '/discover', label: 'Discover', icon: Compass },
  { href: '/tools', label: 'Tools', icon: Grid2X2 },
  { href: '/library', label: 'Library', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

const suggestions = [
  'What should I learn this week?',
  'Explain something I have been avoiding',
  'Help me plan a thoughtful weekend',
  'Find the latest on sustainable design',
];

function readStore<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function openPending(text: string | undefined, mode: Mode) {
  localStorage.setItem(
    'isabella-pending',
    JSON.stringify({ text, mode }),
  );
}

function getStoredMemory(): MemoryItem[] {
  return readStore<MemoryItem[]>('isabella-memory', []);
}

function getDefaultPluginIds(): PluginId[] {
  return availablePlugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => plugin.id);
}

function getInitialEnabledPlugins(): PluginId[] {
  const stored = readStore<PluginId[] | null>(
    PLUGIN_STORAGE_KEY,
    null,
  );

  if (!stored) return getDefaultPluginIds();

  const version = Number(
    localStorage.getItem(PLUGIN_VERSION_KEY) || '0',
  );

  if (version < CURRENT_PLUGIN_VERSION) {
    const migrated = Array.from(
      new Set([
        ...stored,
        'huggingface' as PluginId,
        'higgsfield-video' as PluginId,
        'github' as PluginId,
      ]),
    );

    localStorage.setItem(
      PLUGIN_STORAGE_KEY,
      JSON.stringify(migrated),
    );
    localStorage.setItem(
      PLUGIN_VERSION_KEY,
      String(CURRENT_PLUGIN_VERSION),
    );

    return migrated;
  }

  return stored.filter((id) =>
    availablePlugins.some((plugin) => plugin.id === id),
  );
}

function getEnabledPlugins(): PluginId[] {
  return getInitialEnabledPlugins();
}

function saveMemory(writes: MemoryItem[]) {
  if (!writes.length) return;

  const current = getStoredMemory();

  const merged = [
    ...writes
      .reduce(
        (map, item) =>
          map.set(item.key.trim(), {
            key: item.key.trim(),
            value: item.value.trim(),
          }),
        new Map<string, MemoryItem>(),
      )
      .values(),
    ...current.filter(
      (item) =>
        !writes.some(
          (write) => write.key.trim() === item.key.trim(),
        ),
    ),
  ].slice(0, 50);

  localStorage.setItem(
    'isabella-memory',
    JSON.stringify(merged),
  );
}

async function streamAgent(
  history: Message[],
  mode: Mode,
  enabledPluginIds: PluginId[] = [],
  files: UploadedFile[] = [],
  onStep?: (step: AgentStep) => void,
): Promise<{
  text: string;
  sources: Source[];
  memoryWrites: MemoryItem[];
  videoUrl?: string;
}> {
  const prefs = readStore<Preferences>(
    'isabella-preferences',
    {
      name: '',
      warm: true,
      concise: false,
      web: true,
    },
  );

  const response = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode,
      plugins: enabledPluginIds,
      messages: history.map(({ role, text }) => ({
        role,
        content: text,
      })),
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        text: file.fullText,
      })),
      memory: getStoredMemory(),
      preferences: prefs,
      maxSteps: 4,
    }),
  });

  if (!response.ok) {
    let message =
      'Isabella could not start the agent right now.';

    try {
      const data = (await response.json()) as {
        error?: string;
      };
      message = data.error || message;
    } catch {
      // Keep fallback message.
    }

    throw new Error(message);
  }

  if (!response.body) {
    throw new Error(
      'The agent stream is unavailable in this browser.',
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';

  const finalResultState: {
    value: {
      text: string;
      sources: Source[];
      memoryWrites: MemoryItem[];
    } | null;
  } = {
    value: null,
  };

  const handlePayload = (payload: string) => {
    if (!payload.trim()) return;

    const event = JSON.parse(payload) as
      | AgentStep
      | {
          type: 'done';
          result: {
            text: string;
            sources?: Source[];
            memoryWrites?: MemoryItem[];
            videoUrl?: string;
          };
        }
      | {
          type: 'error';
          message: string;
        };

    if (event.type === 'done') {
      finalResultState.value = {
        text: event.result.text,
        sources: event.result.sources || [],
        memoryWrites: event.result.memoryWrites || [],
        videoUrl: event.result.videoUrl,
      };
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else {
      onStep?.(event);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const eventBlock of events) {
      const dataLine = eventBlock
        .split('\n')
        .find((line) => line.startsWith('data: '));

      if (dataLine) {
        handlePayload(dataLine.slice(6));
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const dataLine = buffer
      .split('\n')
      .find((line) => line.startsWith('data: '));

    if (dataLine) {
      handlePayload(dataLine.slice(6));
    }
  }

  const result = finalResultState.value;

  if (result === null) {
    throw new Error(
      'The agent ended without a final answer.',
    );
  }

  saveMemory(result.memoryWrites);

  return result;
}

async function askIsabella(
  history: Message[],
  mode: Mode,
  enabledPluginIds: PluginId[] = [],
  files: UploadedFile[] = [],
) {
  return streamAgent(
    history,
    mode,
    enabledPluginIds,
    files,
  );
}

async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);

  const response = await fetch('/api/files/upload', {
    method: 'POST',
    body: form,
  });

  const data = (await response.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    text?: string;
    fullText?: string;
    canAnalyze?: boolean;
    error?: string;
  };

  if (!response.ok || !data.id) {
    throw new Error(data.error || 'File upload failed.');
  }

  return {
    id: data.id,
    name: data.name!,
    mimeType: data.mimeType!,
    size: data.size!,
    text: data.text!,
    fullText: data.fullText!,
    canAnalyze: data.canAnalyze,
  };
}

function Brand() {
  return (
    <Link href="/" className="brand" data-testid="link-brand">
      <span className="brand-mark" aria-hidden="true" />
      <span className="brand-name">Isabella</span>
    </Link>
  );
}

function Navigation() {
  const [location] = useLocation();

  return (
    <nav className="rail-nav" aria-label="Primary navigation">
      {navItems.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={`nav-item ${location === href ? 'active' : ''}`}
          data-testid={`link-nav-${label.toLowerCase()}`}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  const [showPlugins, setShowPlugins] = useState(false);
  const [enabledPlugins, setEnabledPlugins] = useState<PluginId[]>(
    () => getInitialEnabledPlugins(),
  );

  useEffect(() => {
    localStorage.setItem(
      PLUGIN_STORAGE_KEY,
      JSON.stringify(enabledPlugins),
    );
    localStorage.setItem(
      PLUGIN_VERSION_KEY,
      String(CURRENT_PLUGIN_VERSION),
    );
  }, [enabledPlugins]);

  const togglePlugin = (pluginId: PluginId) => {
    const plugin = availablePlugins.find(
      (item) => item.id === pluginId,
    );

    if (plugin?.status === 'planned') return;

    setEnabledPlugins((current) =>
      current.includes(pluginId)
        ? current.filter((id) => id !== pluginId)
        : [...current, pluginId],
    );
  };

  const isPluginEnabled = (pluginId: PluginId) =>
    enabledPlugins.includes(pluginId);

  return (
    <div className="isabella-app">
      <div className="shell">
        <aside className="rail" style={{ position: 'relative' }}>
          <Brand />
          <Navigation />
          <div className="rail-divider" />

          <div className="plugins-section">
            <button
              type="button"
              className="plugins-header"
              onClick={() =>
                setShowPlugins((current) => !current)
              }
              aria-expanded={showPlugins}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                padding: '8px 4px',
                color: 'inherit',
                textAlign: 'left',
              }}
            >
              <span className="plugins-title">Plugins</span>
              <ChevronRight
                size={16}
                style={{
                  transform: showPlugins
                    ? 'rotate(90deg)'
                    : 'rotate(0deg)',
                  transition: 'transform 180ms ease',
                }}
              />
            </button>
          </div>

          {showPlugins &&
            createPortal(
              <div
                role="dialog"
                aria-label="Isabella plugins"
                style={{
                  position: 'fixed',
                  left: 18,
                  top: 88,
                  width: 'min(360px, calc(100vw - 36px))',
                  maxHeight: 'calc(100vh - 110px)',
                  overflowY: 'auto',
                  zIndex: 1000,
                  padding: 14,
                  borderRadius: 22,
                  border: '1px solid rgba(255,255,255,0.75)',
                  background:
                    'linear-gradient(145deg, rgba(255,255,255,0.97), rgba(250,239,249,0.96))',
                  boxShadow:
                    '0 24px 70px rgba(93, 56, 105, 0.20)',
                  backdropFilter: 'blur(22px)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 10,
                    padding: '4px 4px 10px',
                  }}
                >
                  <div>
                    <strong
                      style={{
                        display: 'block',
                        fontSize: 16,
                      }}
                    >
                      Isabella plugins
                    </strong>
                    <span
                      style={{
                        display: 'block',
                        marginTop: 3,
                        fontSize: 12,
                        opacity: 0.62,
                      }}
                    >
                      Choose which capabilities Isabella can use.
                    </span>
                  </div>

                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setShowPlugins(false);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setShowPlugins(false);
                    }}
                    aria-label="Close plugins"
                    style={{
                      width: 34,
                      height: 34,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 12,
                      border:
                        '1px solid rgba(125, 83, 140, 0.12)',
                      background: 'rgba(255,255,255,0.75)',
                      cursor: 'pointer',
                      position: 'relative',
                      zIndex: 1002,
                      pointerEvents: 'auto',
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  {availablePlugins.map((plugin) => {
                    const Icon = plugin.icon;
                    const enabled = isPluginEnabled(plugin.id);
                    const isReady = plugin.status === 'ready';

                    return (
                      <div
                        key={plugin.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: 12,
                          borderRadius: 16,
                          border: enabled
                            ? '1px solid rgba(170, 105, 192, 0.24)'
                            : '1px solid rgba(115, 80, 125, 0.09)',
                          background: enabled
                            ? 'rgba(224, 192, 235, 0.28)'
                            : 'rgba(255,255,255,0.52)',
                          opacity: isReady ? 1 : 0.58,
                          transition: 'all 160ms ease',
                        }}
                      >
                        <div
                          style={{
                            width: 38,
                            height: 38,
                            flex: '0 0 38px',
                            display: 'grid',
                            placeItems: 'center',
                            borderRadius: 12,
                            background: 'rgba(255,255,255,0.82)',
                            border:
                              '1px solid rgba(120,80,130,0.08)',
                          }}
                        >
                          <Icon size={17} />
                        </div>

                        <button
                          type="button"
                          disabled={!isReady}
                          onClick={() => togglePlugin(plugin.id)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            border: 0,
                            background: 'transparent',
                            padding: 0,
                            textAlign: 'left',
                            cursor: isReady
                              ? 'pointer'
                              : 'default',
                            color: 'inherit',
                          }}
                        >
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 7,
                              fontWeight: 600,
                              fontSize: 13,
                            }}
                          >
                            {plugin.name}
                            {plugin.id === 'huggingface' && (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '3px 6px',
                                  borderRadius: 999,
                                  background:
                                    'rgba(255,200,106,0.26)',
                                  color: '#875d1e',
                                }}
                              >
                                AI
                              </span>
                            )}
                          </span>

                          <span
                            style={{
                              display: 'block',
                              marginTop: 3,
                              fontSize: 11,
                              lineHeight: 1.35,
                              opacity: 0.62,
                            }}
                          >
                            {isReady
                              ? plugin.description
                              : 'Planned for a future secure tool runtime'}
                          </span>
                        </button>

                        <button
                          type="button"
                          disabled={!isReady}
                          className={`plugin-toggle ${enabled ? 'on' : ''}`}
                          onClick={() => togglePlugin(plugin.id)}
                          aria-pressed={enabled}
                          aria-label={
                            enabled
                              ? `Disable ${plugin.name}`
                              : `Enable ${plugin.name}`
                          }
                          style={{
                            flex: '0 0 auto',
                            cursor: isReady
                              ? 'pointer'
                              : 'not-allowed',
                          }}
                        >
                          <span className="toggle-slider" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>,
              document.body,
            )}

          <div className="rail-spacer" />
          <div className="rail-note">
            <strong>
              A calmer
              <br />
              smarter tomorrow
            </strong>
            <i />
          </div>
        </aside>

        <main className="main-stage">
          <div className="mobile-top">
            <Brand />
            <div className="mobile-nav">
              {navItems.slice(0, 4).map(
                ({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    aria-label={label}
                    data-testid={`mobile-nav-${label.toLowerCase()}`}
                  >
                    <Icon size={16} />
                  </Link>
                ),
              )}
            </div>
          </div>

          <header className="topbar">
            <span className="status-pill">
              <i className="status-dot" />
              Online
            </span>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <button
                type="button"
                className="profile-button"
                aria-label="Open plugins"
                onClick={() => setShowPlugins(true)}
                style={{
                  fontSize: 12,
                  paddingInline: 10,
                }}
              >
                <Sparkles size={15} />
              </button>

              <button
                className="profile-button"
                aria-label="Open settings"
                onClick={() => setLocation('/settings')}
                data-testid="button-profile"
              >
                <UserRound size={17} />
              </button>
            </div>
          </header>

          {children}
        </main>
      </div>
    </div>
  );
}

function Composer({
  onSend,
  selectedMode,
  onMode,
  onLongPressVoice,
  onFileUpload,
  onRemoveFile,
  attachedFiles,
}: {
  onSend: (text: string, mode: Mode) => void;
  selectedMode: Mode;
  onMode: (mode: Mode) => void;
  onLongPressVoice?: () => void;
  onFileUpload?: (files: File[]) => void;
  onRemoveFile?: (id: string) => void;
  attachedFiles?: UploadedFile[];
}) {
  const [value, setValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressTriggered = useRef(false);

  const modes: Mode[] = [
    'Ask',
    'Research',
    'Plan',
    'Explain',
    'Create',
    'Solve',
  ];

  const submit = () => {
    if (value.trim() || attachedFiles?.length) {
      onSend(value.trim(), selectedMode);
      setValue('');
    }
  };

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
    }
    longPressTimer.current = null;
  };

  const beginMicPress = () => {
    longPressTriggered.current = false;
    clearLongPress();

    if (onLongPressVoice) {
      longPressTimer.current = window.setTimeout(() => {
        longPressTriggered.current = true;
        onLongPressVoice();
      }, 550);
    }
  };

  const endMicPress = () => clearLongPress();

  const clickMic = () => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }

    setValue(
      (current) =>
        current || 'I would like to talk through ',
    );
  };

  const handleFileSelect = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || []);

    if (files.length && onFileUpload) {
      onFileUpload(files);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <button
          className="icon-button"
          aria-label="Attach file"
          onClick={() => fileInputRef.current?.click()}
          data-testid="button-attach-file"
        >
          <FileText size={20} />
        </button>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          multiple
          accept=".txt,.md,.csv,.json,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.gif,.webp"
          style={{ display: 'none' }}
        />

        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask Isabella anything..."
          aria-label="Ask Isabella anything"
          data-testid="input-chat-composer"
        />

        <div className="composer-actions">
          <button
            className="icon-button"
            aria-label="Open live voice conversation"
            onPointerDown={beginMicPress}
            onPointerUp={endMicPress}
            onPointerLeave={endMicPress}
            onClick={clickMic}
            data-testid="button-microphone"
          >
            <Mic size={18} />
          </button>

          <button
            className="icon-button send-button"
            aria-label="Send message"
            onClick={submit}
            data-testid="button-send"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>

      {attachedFiles?.length ? (
        <div className="attached-files">
          {attachedFiles.map((file) => (
            <span
              key={file.id}
              className="attached-file"
            >
              {file.name}
              <button
                onClick={() => onRemoveFile?.(file.id)}
                aria-label="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mode-row">
        {modes.map((mode) => (
          <button
            key={mode}
            className={`mode-chip ${
              selectedMode === mode ? 'active' : ''
            }`}
            onClick={() => onMode(mode)}
            data-testid={`button-mode-${mode.toLowerCase()}`}
          >
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}

type VoicePhase =
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

function downsampleTo16k(
  input: Float32Array,
  inputSampleRate: number,
): Int16Array {
  if (inputSampleRate === 16000) {
    const output = new Int16Array(input.length);

    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] =
        sample < 0
          ? sample * 0x8000
          : sample * 0x7fff;
    }

    return output;
  }

  const ratio = inputSampleRate / 16000;
  const outputLength = Math.max(
    1,
    Math.round(input.length / ratio),
  );
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      input.length,
      Math.floor((i + 1) * ratio),
    );

    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }

    const sample = Math.max(
      -1,
      Math.min(1, count ? sum / count : 0),
    );

    output[i] =
      sample < 0
        ? sample * 0x8000
        : sample * 0x7fff;
  }

  return output;
}

function pcm16ToBase64(pcm: Int16Array) {
  const bytes = new Uint8Array(
    pcm.buffer,
    pcm.byteOffset,
    pcm.byteLength,
  );

  const chunkSize = 0x8000;
  let binary = '';

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToInt16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Int16Array(bytes.buffer);
}

function VoiceConversation({
  history,
  onClose,
  onTurn,
}: {
  history: Message[];
  onClose: () => void;
  onTurn: (
    user: Message,
    assistant: Message,
  ) => void;
}) {
  const [phase, setPhase] =
    useState<VoicePhase>('connecting');

  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');

  const sessionRef = useRef<any>(null);
  const streamRef =
    useRef<MediaStream | null>(null);

  const inputContextRef =
    useRef<AudioContext | null>(null);

  const outputContextRef =
    useRef<AudioContext | null>(null);

  const sourceRef =
    useRef<MediaStreamAudioSourceNode | null>(
      null,
    );

  const processorRef =
    useRef<ScriptProcessorNode | null>(null);

  const muteGainRef =
    useRef<GainNode | null>(null);

  const outputSourcesRef =
    useRef<Set<AudioBufferSourceNode>>(
      new Set(),
    );

  const nextPlaybackTimeRef =
    useRef(0);

  const closedRef = useRef(false);
  const historyRef = useRef<Message[]>(history);

  const currentUserTextRef =
    useRef('');

  const currentAssistantTextRef =
    useRef('');

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const stopQueuedAudio = () => {
    for (const source of outputSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }

    outputSourcesRef.current.clear();

    const context = outputContextRef.current;
    if (context) {
      nextPlaybackTimeRef.current =
        context.currentTime;
    }
  };

  const playPcm24k = (base64: string) => {
    const context = outputContextRef.current;

    if (!context) return;

    try {
      const pcm = base64ToInt16(base64);
      if (!pcm.length) return;

      const audioBuffer = context.createBuffer(
        1,
        pcm.length,
        24000,
      );

      const channel =
        audioBuffer.getChannelData(0);

      for (let i = 0; i < pcm.length; i += 1) {
        channel[i] =
          pcm[i] < 0
            ? pcm[i] / 0x8000
            : pcm[i] / 0x7fff;
      }

      const source =
        context.createBufferSource();

      source.buffer = audioBuffer;
      source.connect(context.destination);

      const startTime = Math.max(
        context.currentTime,
        nextPlaybackTimeRef.current,
      );

      source.start(startTime);
      nextPlaybackTimeRef.current =
        startTime + audioBuffer.duration;

      outputSourcesRef.current.add(source);

      source.onended = () => {
        outputSourcesRef.current.delete(source);
      };
    } catch (playbackError) {
      console.error(
        '[Gemini Live] PCM playback error:',
        playbackError,
      );
    }
  };

  const cleanupLiveVoice = () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    muteGainRef.current?.disconnect();

    processorRef.current = null;
    sourceRef.current = null;
    muteGainRef.current = null;

    streamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());

    streamRef.current = null;

    stopQueuedAudio();

    const inputContext =
      inputContextRef.current;

    inputContextRef.current = null;

    if (inputContext) {
      void inputContext.close().catch(() => {});
    }

    const outputContext =
      outputContextRef.current;

    outputContextRef.current = null;

    if (outputContext) {
      void outputContext.close().catch(() => {});
    }

    try {
      sessionRef.current?.close();
    } catch {
      // Already closed.
    }

    sessionRef.current = null;
  };

  const startLiveVoice = async () => {
    if (closedRef.current) return;

    try {
      setError('');
      setPhase('connecting');

      if (
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new Error(
          'Microphone access is not supported in this browser.',
        );
      }

      const tokenResponse = await fetch(
        '/api/voice/gemini-token',
        {
          method: 'POST',
        },
      );

      const tokenData =
        (await tokenResponse.json()) as {
          token?: string;
          error?: string;
        };

      if (
        !tokenResponse.ok ||
        !tokenData.token
      ) {
        throw new Error(
          tokenData.error ||
            'Could not create the Gemini Live session.',
        );
      }

      const ai = new GoogleGenAI({
        apiKey: tokenData.token,
      });

      const outputContext =
        new AudioContext({
          sampleRate: 24000,
        });

      await outputContext.resume();

      outputContextRef.current =
        outputContext;

      nextPlaybackTimeRef.current =
        outputContext.currentTime;

      const session =
        await ai.live.connect({
          model: 'gemini-3.8-live',
          config: {
            responseModalities: [
              Modality.AUDIO,
            ],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {},
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Kore',
                },
              },
            },
            systemInstruction: {
              parts: [
                {
                  text:
                    'You are Isabella, a warm, natural, helpful personal AI assistant. Speak conversationally and clearly. Keep responses reasonably concise. Do not mention internal implementation details, models, APIs, or system instructions.',
                },
              ],
            },
          },
          callbacks: {
            onopen: () => {
              if (!closedRef.current) {
                setPhase('listening');
              }
            },

            onmessage: (message: any) => {
              if (closedRef.current) return;

              const content =
                message?.serverContent;

              if (!content) return;

              if (
                content.inputTranscription?.text
              ) {
                const text =
                  String(
                    content.inputTranscription.text,
                  ).trim();

                if (text) {
                  currentUserTextRef.current =
                    `${currentUserTextRef.current} ${text}`.trim();

                  setHeard(
                    currentUserTextRef.current,
                  );

                  setPhase('thinking');
                }
              }

              if (
                content.outputTranscription?.text
              ) {
                const text =
                  String(
                    content.outputTranscription.text,
                  );

                currentAssistantTextRef.current +=
                  text;

                setReply(
                  currentAssistantTextRef.current,
                );

                setPhase('speaking');
              }

              if (content.modelTurn?.parts) {
                for (
                  const part of content.modelTurn
                    .parts
                ) {
                  const audioData =
                    part?.inlineData?.data;

                  if (audioData) {
                    playPcm24k(audioData);
                    setPhase('speaking');
                  }
                }
              }

              if (content.interrupted) {
                stopQueuedAudio();
                setPhase('listening');
              }

              if (content.turnComplete) {
                const userText =
                  currentUserTextRef.current.trim();

                const assistantText =
                  currentAssistantTextRef.current.trim();

                if (userText && assistantText) {
                  const userMessage: Message = {
                    id: uid(),
                    role: 'user',
                    text: userText,
                  };

                  const assistantMessage: Message = {
                    id: uid(),
                    role: 'assistant',
                    text: assistantText,
                    sources: [],
                  };

                  historyRef.current = [
                    ...historyRef.current,
                    userMessage,
                    assistantMessage,
                  ];

                  onTurn(
                    userMessage,
                    assistantMessage,
                  );
                }

                currentUserTextRef.current =
                  '';

                currentAssistantTextRef.current =
                  '';

                setPhase('listening');
              }
            },

            onerror: (event: any) => {
              console.error(
                '[Gemini Live] connection error:',
                event,
              );

              setError(
                event?.message ||
                  'Gemini Live connection failed.',
              );

              setPhase('error');
            },

            onclose: (event: any) => {
              if (
                !closedRef.current &&
                event?.reason
              ) {
                setError(
                  event.reason,
                );
                setPhase('error');
              }
            },
          },
        });

      sessionRef.current = session;

      if (closedRef.current) {
        session.close();
        return;
      }

      const priorTurns =
        historyRef.current
          .slice(-8)
          .filter((item) => item.text.trim())
          .map((item) => ({
            role:
              item.role === 'assistant'
                ? 'model'
                : 'user',
            parts: [{ text: item.text }],
          }));

      if (priorTurns.length) {
        session.sendClientContent({
          turns: priorTurns,
          turnComplete: false,
        });
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

      if (closedRef.current) {
        stream
          .getTracks()
          .forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      const inputContext =
        new AudioContext();

      await inputContext.resume();

      inputContextRef.current =
        inputContext;

      const source =
        inputContext.createMediaStreamSource(
          stream,
        );

      const processor =
        inputContext.createScriptProcessor(
          4096,
          1,
          1,
        );

      const muteGain =
        inputContext.createGain();

      muteGain.gain.value = 0;

      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(
        inputContext.destination,
      );

      sourceRef.current = source;
      processorRef.current = processor;
      muteGainRef.current = muteGain;

      processor.onaudioprocess = (event) => {
        if (
          closedRef.current ||
          !sessionRef.current
        ) {
          return;
        }

        const input =
          event.inputBuffer.getChannelData(0);

        const pcm =
          downsampleTo16k(
            input,
            inputContext.sampleRate,
          );

        if (!pcm.length) return;

        const data =
          pcm16ToBase64(pcm);

        try {
          session.sendRealtimeInput({
            audio: {
              data,
              mimeType:
                'audio/pcm;rate=16000',
            },
          });
        } catch (sendError) {
          console.error(
            '[Gemini Live] audio send error:',
            sendError,
          );
        }
      };

      setHeard('');
      setReply('');
      setError('');
      setPhase('listening');
    } catch (caught) {
      console.error(
        '[Gemini Live] startup failed:',
        caught,
      );

      cleanupLiveVoice();

      if (!closedRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Gemini Live could not start.',
        );
        setPhase('error');
      }
    }
  };

  useEffect(() => {
    closedRef.current = false;
    void startLiveVoice();

    return () => {
      closedRef.current = true;
      cleanupLiveVoice();
    };
  }, []);

  return (
    <div
      className="voice-room"
      role="dialog"
      aria-modal="true"
      aria-label="Isabella live voice conversation"
    >
      <div className="voice-room-top">
        <div className="status-pill">
          <i className="status-dot" />
          Live with Isabella
        </div>

        <button
          className="voice-close"
          onClick={() => {
            closedRef.current = true;
            cleanupLiveVoice();
            onClose();
          }}
          aria-label="Close live conversation"
        >
          Close
        </button>
      </div>

      <div className={`voice-stage ${phase}`}>
        <div
          className={`voice-orb voice-orb-${phase}`}
          aria-hidden="true"
        >
          <div className="voice-orb-glow" />
          <div className="voice-orb-core" />
          <div className="voice-orbit voice-orbit-one" />
          <div className="voice-orbit voice-orbit-two" />
        </div>

        <p className="voice-phase">
          {phase === 'connecting'
            ? 'Connecting…'
            : phase === 'listening'
              ? 'Listening…'
              : phase === 'thinking'
                ? 'Thinking…'
                : phase === 'speaking'
                  ? 'Isabella is speaking'
                  : 'Microphone needs attention'}
        </p>

        <h2>Talk to Isabella</h2>

        <p className="voice-hint">
          {error ||
            (phase === 'connecting'
              ? 'Starting the live conversation…'
              : phase === 'listening'
                ? 'Speak naturally. Pause when you are finished.'
                : phase === 'thinking'
                  ? 'I heard you. Give me a moment…'
                  : phase === 'speaking'
                    ? 'You can interrupt Isabella at any time.'
                    : 'Tap the microphone to reconnect.')}
        </p>

        {heard && (
          <div className="voice-transcript">
            <span>You</span>
            <p>{heard}</p>
          </div>
        )}

        {reply && (
          <div className="voice-reply">
            <span>Isabella</span>
            <p>{reply}</p>
          </div>
        )}
      </div>

      <div className="voice-controls">
        <button
          type="button"
          className={`voice-mic ${
            phase === 'listening' ||
            phase === 'speaking' ||
            phase === 'thinking'
              ? 'active'
              : ''
          }`}
          onClick={() => {
            cleanupLiveVoice();
            closedRef.current = false;
            setError('');

            if (phase === 'error') {
              void startLiveVoice();
            } else {
              setPhase('connecting');
              void startLiveVoice();
            }
          }}
          aria-label="Restart live microphone"
        >
          <Mic size={23} />
        </button>

        <span>
          {phase === 'error'
            ? 'Tap to reconnect'
            : 'Live microphone · pause to send'}
        </span>
      </div>
    </div>
  );
}

function Home({
  onOpenChat,
  onOpenVoice,
}: {
  onOpenChat: (
    text?: string,
    mode?: Mode,
  ) => void;
  onOpenVoice: () => void;
}) {
  const shortcuts: {
    label: string;
    icon: typeof Search;
    mode: Mode;
  }[] = [
    {
      label: 'Search the web',
      icon: Search,
      mode: 'Research',
    },
    {
      label: 'Help me learn',
      icon: Lightbulb,
      mode: 'Explain',
    },
    {
      label: 'Create something',
      icon: FileText,
      mode: 'Create',
    },
    {
      label: 'More tools',
      icon: Grid2X2,
      mode: 'Ask',
    },
  ];

  return (
    <section className="home-content content">
      <div className="orb-wrap" aria-hidden="true">
        <div className="orb" />
      </div>

      <h1 className="hero-title">Isabella</h1>

      <p className="hero-subtitle">
        Here to listen, think, and help — always with you.
      </p>

      <div className="shortcut-row">
        {shortcuts.map(({ label, icon: Icon, mode }) => (
          <button
            className="shortcut"
            key={label}
            onClick={() => onOpenChat(undefined, mode)}
            data-testid={`button-shortcut-${label
              .replaceAll(' ', '-')
              .toLowerCase()}`}
          >
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <Composer
        onSend={(text, mode) => onOpenChat(text, mode)}
        selectedMode="Ask"
        onMode={(mode) => onOpenChat(undefined, mode)}
        onLongPressVoice={onOpenVoice}
      />

      <div className="thinking-card">
        <Sparkles
          className="thinking-spark"
          size={20}
        />
        <span>
          Thinking
          <br />
          for you...
        </span>
        <div
          style={{
            marginTop: 10,
            letterSpacing: 4,
          }}
        >
          ···
        </div>
      </div>
    </section>
  );
}

function formatAgentStepMessage(step: AgentStep): string {
  const message = step.message.trim();

  if (message) return message;

  if (step.tool === 'github') {
    if (step.type === 'tool_call') return 'GitHub is working…';
    if (step.type === 'tool_result') return 'GitHub returned a result.';
  }

  return 'Isabella is working…';
}

function Chat() {
  const [, setLocation] = useLocation();

  const [mode, setMode] =
    useState<Mode>('Ask');

  const [voiceOpen, setVoiceOpen] =
    useState(false);

  const [conversations, setConversations] =
    useState<Conversation[]>(() =>
      readStore(
        'isabella-conversations',
        [],
      ),
    );

  const [activeId, setActiveId] =
    useState<string>(() => uid());

  const [messages, setMessages] =
    useState<Message[]>([]);

  const [busy, setBusy] =
    useState(false);

  const [agentSteps, setAgentSteps] =
    useState<AgentStep[]>([]);

  const [attachedFiles, setAttachedFiles] =
    useState<UploadedFile[]>([]);

  useEffect(() => {
    const pending =
      readStore<{
        text?: string;
        mode?: Mode;
      } | null>(
        'isabella-pending',
        null,
      );

    if (
      localStorage.getItem(
        'isabella-open-voice',
      )
    ) {
      localStorage.removeItem(
        'isabella-open-voice',
      );

      setVoiceOpen(true);
    }

    if (pending?.text) {
      localStorage.removeItem(
        'isabella-pending',
      );

      const pendingMode =
        pending.mode || 'Ask';

      setMode(pendingMode);

      void send(
        pending.text,
        pendingMode,
      );
    } else if (pending?.mode) {
      setMode(pending.mode);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      'isabella-conversations',
      JSON.stringify(conversations),
    );
  }, [conversations]);

  async function handleFileUpload(
    files: File[],
  ) {
    if (!files.length) {
      setAttachedFiles([]);
      return;
    }

    try {
      const uploaded =
        await Promise.all(
          files.map(uploadFile),
        );

      setAttachedFiles(
        (current) => [
          ...current,
          ...uploaded,
        ],
      );
    } catch (error) {
      console.error(
        'File upload failed:',
        error,
      );
    }
  }

  async function send(
    text: string,
    selected: Mode,
  ) {
    const enabledPlugins =
      getEnabledPlugins();

    const filesToSend = [
      ...attachedFiles,
    ];

    if (
      !text.trim() &&
      !filesToSend.length
    ) {
      return;
    }

    const userMessage: Message = {
      id: uid(),
      role: 'user',
      text,
      files: filesToSend,
    };

    const history = [
      ...messages,
      userMessage,
    ];

    setMessages((current) => [
      ...current,
      userMessage,
    ]);

    setAttachedFiles([]);
    setBusy(true);
    setAgentSteps([]);

    try {
      const found =
        await streamAgent(
          history,
          selected,
          enabledPlugins,
          filesToSend,
          (step) =>
            setAgentSteps(
              (current) => [
                ...current,
                step,
              ],
            ),
        );

      const assistant: Message = {
        id: uid(),
        role: 'assistant',
        text: found.text,
        sources: found.sources,
        videoUrl: found.videoUrl,
      };

      setMessages((current) => [
        ...current,
        assistant,
      ]);

      setConversations(
        (current) => {
          const existing =
            current.find(
              (item) =>
                item.id === activeId,
            );

          const title = (
            text ||
            filesToSend[0]?.name ||
            'Conversation'
          ).slice(0, 42);

          const next =
            existing
              ? {
                  ...existing,
                  title:
                    existing.title ===
                    'New conversation'
                      ? title
                      : existing.title,
                  messages: [
                    ...existing.messages,
                    userMessage,
                    assistant,
                  ],
                  updatedAt:
                    new Date().toISOString(),
                }
              : {
                  id: activeId,
                  title,
                  messages: [
                    userMessage,
                    assistant,
                  ],
                  updatedAt:
                    new Date().toISOString(),
                  saved: false,
                };

          return [
            next,
            ...current.filter(
              (item) =>
                item.id !== activeId,
            ),
          ].slice(0, 30);
        },
      );
    } catch (error) {
      const assistant: Message = {
        id: uid(),
        role: 'assistant',
        text:
          error instanceof Error
            ? error.message
            : 'Isabella could not answer right now.',
        sources: [],
      };

      setMessages((current) => [
        ...current,
        assistant,
      ]);
    } finally {
      setBusy(false);
    }
  }

  const clear = () => {
    const oldId = activeId;

    setMessages([]);
    setAgentSteps([]);
    setAttachedFiles([]);
    setActiveId(uid());

    setConversations((current) =>
      current.filter(
        (item) => item.id !== oldId,
      ),
    );

    setLocation('/');
  };

  const toggleSave = () => {
    setConversations((current) => {
      const existing =
        current.find(
          (item) => item.id === activeId,
        );

      if (existing) {
        return current.map(
          (item) =>
            item.id === activeId
              ? {
                  ...item,
                  saved: !item.saved,
                }
              : item,
        );
      }

      if (!messages.length) {
        return current;
      }

      return [
        {
          id: activeId,
          title:
            messages
              .find(
                (item) =>
                  item.role ===
                  'user',
              )
              ?.text.slice(
                0,
                42,
              ) ||
            'Conversation',
          messages,
          updatedAt:
            new Date().toISOString(),
          saved: true,
        },
        ...current,
      ];
    });
  };

  return (
    <section className="chat-page">
      <div className="chat-top">
        <div>
          <h1>Let's think it through.</h1>
          <span>
            {messages.length
              ? 'A private conversation, saved locally'
              : 'A quiet place to start'}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 3,
          }}
        >
          <button
            className="icon-button"
            aria-label="Save this conversation"
            onClick={toggleSave}
            data-testid="button-save-conversation"
          >
            <Bookmark size={18} />
          </button>

          <button
            className="icon-button"
            aria-label="Start a new conversation"
            onClick={clear}
            data-testid="button-new-chat"
          >
            <Plus size={19} />
          </button>
        </div>
      </div>

      <div className="message-list" aria-live="polite">
        {!messages.length && !busy && (
          <div className="empty-state">
            <Sparkles size={26} />
            <p>What is on your mind?</p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${message.role}`}
            data-testid={`message-${message.id}`}
          >
            <span className="message-avatar">
              {message.role === 'assistant' ? (
                <Sparkles size={14} />
              ) : (
                <UserRound size={14} />
              )}
            </span>

            <div>
              <div className="message-bubble">
                {message.text}
              </div>

              {message.files?.length ? (
                <div className="message-files">
                  {message.files.map((file) => (
                    <span
                      key={file.id}
                      className="message-file"
                    >
                      {file.name} ({file.mimeType})
                    </span>
                  ))}
                </div>
              ) : null}

              {message.sources?.length ? (
                <div className="source-row">
                  {message.sources.map((source) => (
                    <a
                      className="source-link"
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      key={source.url}
                      data-testid={`link-source-${source.title}`}
                    >
                      <ExternalLink size={10} />
                      {source.title}
                    </a>
                  ))}
                </div>
              ) : null}

              {message.videoUrl ? (
                <div
                  className="source-row"
                  style={{ marginTop: 8 }}
                >
                  <a
                    className="source-link"
                    href={message.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`link-video-${message.id}`}
                  >
                    <ExternalLink size={10} />
                    Open generated video
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {busy && (
          <div
            className="agent-trace"
            data-testid="agent-trace"
          >
            <div className="agent-trace-title">
              <Sparkles size={15} />
              Isabella agent
            </div>

            {(
              agentSteps.length
                ? agentSteps
                : [
                    {
                      id: 'thinking',
                      type: 'status' as const,
                      message:
                        'Understanding your goal…',
                      timestamp:
                        new Date().toISOString(),
                    },
                  ]
            )
              .slice(-6)
              .map((step) => (
                <div
                  className="agent-trace-row"
                  key={step.id}
                >
                  <span
                    className={`agent-trace-dot ${step.type}`}
                  />
                  <span>{formatAgentStepMessage(step)}</span>
                </div>
              ))}
          </div>
        )}

        {busy && (
          <div className="message assistant">
            <span className="message-avatar">
              <Sparkles size={14} />
            </span>

            <div className="message-bubble typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <div className="chat-composer">
        <Composer
          onSend={send}
          selectedMode={mode}
          onMode={setMode}
          onLongPressVoice={() =>
            setVoiceOpen(true)
          }
          onFileUpload={handleFileUpload}
          onRemoveFile={(id) =>
            setAttachedFiles(
              (current) =>
                current.filter(
                  (file) => file.id !== id,
                ),
            )
          }
          attachedFiles={attachedFiles}
        />
      </div>

      {voiceOpen && (
        <VoiceConversation
          history={messages}
          onClose={() =>
            setVoiceOpen(false)
          }
          onTurn={(
            userMessage,
            assistantMessage,
          ) => {
            setMessages(
              (current) => [
                ...current,
                userMessage,
                assistantMessage,
              ],
            );

            setConversations(
              (current) => {
                const existing =
                  current.find(
                    (item) =>
                      item.id ===
                      activeId,
                  );

                const next =
                  existing
                    ? {
                        ...existing,
                        title:
                          existing.title ===
                          'New conversation'
                            ? userMessage.text.slice(
                                0,
                                42,
                              )
                            : existing.title,
                        messages: [
                          ...existing.messages,
                          userMessage,
                          assistantMessage,
                        ],
                        updatedAt:
                          new Date().toISOString(),
                      }
                    : {
                        id: activeId,
                        title:
                          userMessage.text.slice(
                            0,
                            42,
                          ),
                        messages: [
                          userMessage,
                          assistantMessage,
                        ],
                        updatedAt:
                          new Date().toISOString(),
                        saved: false,
                      };

                return [
                  next,
                  ...current.filter(
                    (item) =>
                      item.id !==
                      activeId,
                  ),
                ].slice(0, 30);
              },
            );
          }}
        />
      )}
    </section>
  );
}

async function fetchSearch(
  query: string,
): Promise<{
  text: string;
  sources: Source[];
}> {
  const endpoint =
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
      query,
    )}&limit=4&namespace=0&format=json&origin=*`;

  try {
    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error('Search unavailable');
    }

    const data =
      (await response.json()) as [
        string,
        string[],
        string[],
        string[],
      ];

    const sources =
      (data[1] || []).map(
        (title, index) => ({
          title,
          url:
            data[3]?.[index] ||
            `https://en.wikipedia.org/wiki/${encodeURIComponent(
              title.replaceAll(' ', '_'),
            )}`,
        }),
      );

    if (!sources.length) {
      return {
        text:
          'I could not find a public result for that yet. Try a slightly broader phrase.',
        sources: [],
      };
    }

    return {
      text: `I found ${sources.length} public reference pages for “${query}”.`,
      sources,
    };
  } catch {
    return {
      text:
        'The public search connection is unavailable right now.',
      sources: [],
    };
  }
}

function Discover() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const [results, setResults] =
    useState<{
      text: string;
      sources: Source[];
    } | null>(null);

  const search = async (value = query) => {
    if (!value.trim()) return;

    setQuery(value);
    setLoading(true);
    setResults(await fetchSearch(value));
    setLoading(false);
  };

  return (
    <section className="page content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            A little further
          </p>

          <h1 className="page-title">
            Discover
          </h1>

          <p className="page-intro">
            Bring a question, a curiosity, or a
            half-formed idea. Isabella will make a
            considered first pass, with sources when you
            want to go deeper.
          </p>
        </div>
      </div>

      <div className="research-grid">
        <div className="glass-card research-box">
          <p className="section-label">
            Search the public web
          </p>

          <form
            className="research-form"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <input
              className="research-input"
              value={query}
              onChange={(event) =>
                setQuery(event.target.value)
              }
              placeholder="What would you like to understand?"
              aria-label="Search the public web"
              data-testid="input-discover-search"
            />

            <button
              className="primary-button"
              type="submit"
              disabled={loading}
              data-testid="button-discover-search"
            >
              {loading ? 'Looking…' : 'Search'}
            </button>
          </form>

          {results && (
            <div className="result-list">
              <p className="result-snippet">
                {results.text}
              </p>

              {results.sources.map((source) => (
                <a
                  className="glass-card result-card"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  key={source.url}
                  data-testid={`discover-result-${source.title}`}
                >
                  <p className="result-title">
                    {source.title}
                  </p>

                  <p className="result-snippet">
                    Public reference from Wikipedia
                  </p>

                  <span className="result-source">
                    <ExternalLink size={11} />
                    Open source
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="glass-card research-box">
          <p className="section-label">
            Try asking about
          </p>

          <div className="suggestion-list">
            {suggestions.map((item) => (
              <button
                className="suggestion"
                key={item}
                onClick={() => {
                  setQuery(item);
                  void search(item);
                }}
                data-testid={`button-suggestion-${item
                  .slice(0, 12)
                  .replaceAll(' ', '-')
                  .toLowerCase()}`}
              >
                <span>{item}</span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="glass-card"
        style={{
          marginTop: 18,
          padding: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div className="tool-icon" style={{ margin: 0 }}>
          <Sparkles size={18} />
        </div>

        <div style={{ flex: 1 }}>
          <p
            className="section-label"
            style={{ marginBottom: 4 }}
          >
            Prefer a thoughtful answer?
          </p>

          <p className="result-snippet">
            Take your question back to the quiet chat
            space and Isabella will work from her local
            knowledge.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={() => setLocation('/')}
          data-testid="button-return-chat"
        >
          Open chat
        </button>
      </div>
    </section>
  );
}

function Tools() {
  const [, setLocation] = useLocation();

  const tools: {
    title: string;
    icon: typeof Search;
    copy: string;
    action: string;
    prompt?: string;
    mode?: Mode;
  }[] = [
    {
      title: 'Daily plan',
      icon: ListTodo,
      copy:
        'Turn an intention into a gentle, realistic sequence of next steps.',
      action: 'Plan my day',
      prompt: 'Help me plan my day',
      mode: 'Plan',
    },
    {
      title: 'Explain it simply',
      icon: Lightbulb,
      copy:
        'Get a layered explanation that meets you where you are.',
      action: 'Explain something',
      prompt: 'Explain something simply',
      mode: 'Explain',
    },
    {
      title: 'Writing room',
      icon: PenLine,
      copy:
        'Shape a note, draft, outline, or message without starting from a blank page.',
      action: 'Help me write',
      prompt: 'Help me write something',
      mode: 'Create',
    },
    {
      title: 'Quick calculations',
      icon: Calculator,
      copy:
        'Do a small bit of practical math without opening another tab.',
      action: 'Calculate something',
      prompt: 'I need help with a calculation',
      mode: 'Solve',
    },
    {
      title: 'Reflection prompt',
      icon: CalendarDays,
      copy:
        'Make a little space to notice what is working and what needs care.',
      action: 'Give me a prompt',
      prompt: 'Give me a thoughtful reflection prompt',
      mode: 'Ask',
    },
    {
      title: 'Save a thought',
      icon: Bookmark,
      copy:
        'Keep a useful idea in your local library for later.',
      action: 'Open library',
    },
  ];

  const runTool = (
    tool: {
      action: string;
      prompt?: string;
      mode?: Mode;
    },
  ) => {
    if (tool.action === 'Open library') {
      setLocation('/library');
      return;
    }

    openPending(
      tool.prompt,
      tool.mode || 'Ask',
    );

    setLocation('/chat');
  };

  return (
    <section className="page content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            Small levers, useful outcomes
          </p>

          <h1 className="page-title">
            Tools
          </h1>

          <p className="page-intro">
            A handful of focused ways to move from “I
            should” to something you can actually begin.
          </p>
        </div>
      </div>

      <div className="tool-grid">
        {tools.map(
          ({
            title,
            icon: Icon,
            copy,
            action,
            prompt,
            mode,
          }) => (
            <article
              className="glass-card tool-card"
              key={title}
            >
              <div className="tool-icon">
                <Icon size={19} />
              </div>

              <h3>{title}</h3>
              <p>{copy}</p>

              <button
                className="tool-link"
                onClick={() =>
                  runTool({
                    action,
                    prompt,
                    mode,
                  })
                }
                data-testid={`button-tool-${title
                  .replaceAll(
                    ' ',
                    '-',
                  )
                  .toLowerCase()}`}
              >
                {action}
                <ChevronRight size={13} />
              </button>
            </article>
          ),
        )}
      </div>
    </section>
  );
}

function Library() {
  const [conversations, setConversations] =
    useState<Conversation[]>(() =>
      readStore(
        'isabella-conversations',
        [],
      ),
    );

  const [notes, setNotes] =
    useState<
      {
        id: string;
        text: string;
        createdAt: string;
      }[]
    >(() =>
      readStore(
        'isabella-notes',
        [],
      ),
    );

  const [note, setNote] =
    useState('');

  useEffect(() => {
    localStorage.setItem(
      'isabella-conversations',
      JSON.stringify(conversations),
    );
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(
      'isabella-notes',
      JSON.stringify(notes),
    );
  }, [notes]);

  const addNote = () => {
    if (note.trim()) {
      setNotes([
        {
          id: uid(),
          text: note.trim(),
          createdAt:
            new Date().toISOString(),
        },
        ...notes,
      ]);

      setNote('');
    }
  };

  const savedConversations =
    conversations.filter(
      (item) =>
        item.saved,
    );

  return (
    <section className="page content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            Your thinking, kept close
          </p>

          <h1 className="page-title">
            Library
          </h1>

          <p className="page-intro">
            Conversations and small notes live here on this
            device. Nothing leaves your browser unless you
            choose to share it.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr .8fr',
          gap: 18,
        }}
        className="library-layout"
      >
        <div>
          <p className="section-label">
            Saved conversations
          </p>

          <div className="library-list">
            {savedConversations.length ? (
              savedConversations.map(
                (conversation) => (
                  <div
                    className="glass-card library-row"
                    key={conversation.id}
                  >
                    <MessageCircle size={18} />

                    <div className="library-row-main">
                      <h3>
                        {conversation.title}
                      </h3>

                      <p>
                        {formatDate(
                          conversation.updatedAt,
                        )}{' '}
                        ·{' '}
                        {
                          conversation.messages
                            .length
                        }{' '}
                        messages
                      </p>
                    </div>

                    <div className="library-actions">
                      <button
                        className="icon-button"
                        aria-label={`Remove ${conversation.title} from library`}
                        onClick={() =>
                          setConversations(
                            conversations.map(
                              (item) =>
                                item.id ===
                                conversation.id
                                  ? {
                                      ...item,
                                      saved: false,
                                    }
                                  : item,
                            ),
                          )
                        }
                        data-testid={`button-unsave-${conversation.id}`}
                      >
                        <Bookmark size={16} />
                      </button>
                    </div>
                  </div>
                ),
              )
            ) : (
              <div className="glass-card empty-state">
                <Bookmark size={25} />
                <p>
                  Saved conversations will appear here.
                </p>
              </div>
            )}
          </div>
        </div>

        <div>
          <p className="section-label">
            Quick notes
          </p>

          <div
            className="glass-card"
            style={{ padding: 16 }}
          >
            <textarea
              className="research-input"
              style={{
                minHeight: 88,
                paddingTop: 11,
              }}
              value={note}
              onChange={(event) =>
                setNote(event.target.value)
              }
              placeholder="Keep a thought for later…"
              aria-label="New quick note"
              data-testid="input-new-note"
            />

            <button
              className="primary-button"
              style={{
                marginTop: 9,
                width: '100%',
              }}
              onClick={addNote}
              data-testid="button-save-note"
            >
              Save note
            </button>
          </div>

          <div
            className="library-list"
            style={{ marginTop: 10 }}
          >
            {notes.map((item) => (
              <div
                className="glass-card library-row"
                key={item.id}
              >
                <FileText size={16} />

                <div className="library-row-main">
                  <h3
                    style={{
                      whiteSpace: 'normal',
                    }}
                  >
                    {item.text}
                  </h3>

                  <p>
                    {formatDate(
                      item.createdAt,
                    )}
                  </p>
                </div>

                <button
                  className="icon-button"
                  aria-label="Delete note"
                  onClick={() =>
                    setNotes(
                      notes.filter(
                        (noteItem) =>
                          noteItem.id !==
                          item.id,
                      ),
                    )
                  }
                  data-testid={`button-delete-note-${item.id}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Settings() {
  const [prefs, setPrefs] =
    useState<Preferences>(
      () =>
        readStore(
          'isabella-preferences',
          {
            name: '',
            warm: true,
            concise: false,
            web: true,
          },
        ),
    );

  const update = (
    patch: Partial<Preferences>,
  ) =>
    setPrefs((current) => {
      const next = {
        ...current,
        ...patch,
      };

      localStorage.setItem(
        'isabella-preferences',
        JSON.stringify(next),
      );

      return next;
    });

  const reset = () => {
    const next = {
      name: '',
      warm: true,
      concise: false,
      web: true,
    };

    setPrefs(next);

    localStorage.setItem(
      'isabella-preferences',
      JSON.stringify(next),
    );
  };

  return (
    <section className="page content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            Make it feel like yours
          </p>

          <h1 className="page-title">
            Settings
          </h1>

          <p className="page-intro">
            A few gentle preferences for the way Isabella
            thinks alongside you.
          </p>
        </div>
      </div>

      <div className="settings-layout">
        <div className="glass-card settings-nav">
          <button
            className="settings-tab active"
            data-testid="settings-tab-preferences"
          >
            Preferences
          </button>

          <button
            className="settings-tab"
            onClick={reset}
            data-testid="button-reset-settings"
          >
            Reset to defaults
          </button>
        </div>

        <div className="glass-card settings-panel">
          <h2>
            How Isabella shows up
          </h2>

          <p>
            These choices are stored locally in your browser.
          </p>

          <div className="setting-row">
            <div className="setting-copy">
              <strong>Your name</strong>
              <span>
                Used only to make greetings feel a little
                more personal.
              </span>
            </div>

            <input
              className="text-input"
              value={prefs.name}
              onChange={(event) =>
                update({
                  name: event.target.value,
                })
              }
              placeholder="Optional"
              aria-label="Your name"
              data-testid="input-preferences-name"
            />
          </div>

          <div className="setting-row">
            <div className="setting-copy">
              <strong>
                Warm, conversational tone
              </strong>

              <span>
                Keep answers human, calm, and a little more
                spacious.
              </span>
            </div>

            <button
              className={`toggle ${
                prefs.warm ? 'on' : ''
              }`}
              onClick={() =>
                update({
                  warm: !prefs.warm,
                })
              }
              aria-pressed={prefs.warm}
              aria-label="Toggle warm conversational tone"
              data-testid="toggle-warm"
            >
              <span />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-copy">
              <strong>
                Concise by default
              </strong>

              <span>
                Prefer a short first answer with room to ask
                for more.
              </span>
            </div>

            <button
              className={`toggle ${
                prefs.concise ? 'on' : ''
              }`}
              onClick={() =>
                update({
                  concise: !prefs.concise,
                })
              }
              aria-pressed={prefs.concise}
              aria-label="Toggle concise answers"
              data-testid="toggle-concise"
            >
              <span />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-copy">
              <strong>
                Research when asked
              </strong>

              <span>
                Allow public source lookups from Discover and
                Research mode.
              </span>
            </div>

            <button
              className={`toggle ${
                prefs.web ? 'on' : ''
              }`}
              onClick={() =>
                update({
                  web: !prefs.web,
                })
              }
              aria-pressed={prefs.web}
              aria-label="Toggle public research"
              data-testid="toggle-web"
            >
              <span />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function AppRouter() {
  const [, setLocation] = useLocation();

  const openVoice = () => {
    localStorage.setItem(
      'isabella-open-voice',
      '1',
    );

    setLocation('/chat');
  };

  return (
    <Shell>
      <Switch>
        <Route path="/">
          <Home
            onOpenChat={(text, mode) => {
              openPending(
                text,
                mode || 'Ask',
              );

              setLocation('/chat');
            }}
            onOpenVoice={openVoice}
          />
        </Route>

        <Route
          path="/chat"
        >
          <Chat />
        </Route>

        <Route
          path="/discover"
          component={Discover}
        />

        <Route
          path="/tools"
          component={Tools}
        />

        <Route
          path="/library"
          component={Library}
        />

        <Route
          path="/settings"
          component={Settings}
        />

        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <AppRouter />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
