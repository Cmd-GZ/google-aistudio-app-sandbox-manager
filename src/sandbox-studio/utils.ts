export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${idx === 0 ? value : value.toFixed(1)} ${units[idx]}`;
}

export function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function joinPosixPath(parent: string, child: string): string {
  const cleanChild = child.replace(/^\/+|\/+$/g, '');
  if (!cleanChild) return parent || '/';
  if (parent === '/') return `/${cleanChild}`;
  const cleanParent = parent.replace(/\/+$/, '');
  return `${cleanParent}/${cleanChild}`;
}

export function getParentPath(absPath: string): string {
  const cleaned = absPath.replace(/\/+$/, '');
  if (!cleaned || cleaned === '/') return '/';
  const lastSlash = cleaned.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return cleaned.slice(0, lastSlash);
}

export function getBasename(absPath: string): string {
  const cleaned = absPath.replace(/\/+$/, '');
  if (!cleaned || cleaned === '/') return '/';
  const lastSlash = cleaned.lastIndexOf('/');
  return lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
