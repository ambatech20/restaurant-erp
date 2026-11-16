import fs from 'fs';
import path from 'path';

const BACKUP_DIR = path.join(process.cwd(), 'backups');

/** The hosted deployment has no SQLite file to copy and a read-only filesystem. */
const HOSTED = Boolean(process.env.VERCEL);

export function getDatabasePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';
  let file = url;
  if (file.startsWith('file:')) file = file.slice('file:'.length);
  if (file.startsWith('//')) file = file.slice(2);
  // Prisma resolves relative paths against the schema directory (prisma/).
  if (!path.isAbsolute(file)) {
    const candidate = path.join(process.cwd(), 'prisma', file);
    if (fs.existsSync(/*turbopackIgnore: true*/ candidate)) return candidate;
    return path.join(/*turbopackIgnore: true*/ process.cwd(), file);
  }
  return file;
}

export function ensureBackupDir(): string {
  if (HOSTED) throw new Error('File backups are not available on the hosted deployment');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

function safeName(name: string): string | null {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  if (!/^backup-[a-z]+-\d{8}-\d{6}\.db$/.test(name)) return null;
  return name;
}

export function createBackup(label: 'daily' | 'weekly' | 'monthly'): BackupInfo {
  ensureBackupDir();  const dbPath = getDatabasePath();
  if (!fs.existsSync(/*turbopackIgnore: true*/ dbPath)) throw new Error('Database file not found');
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filename = `backup-${label}-${stamp}.db`;
  const dest = path.join(BACKUP_DIR, filename);
  fs.copyFileSync(dbPath, dest);
  const stat = fs.statSync(dest);
  return { filename, size: stat.size, createdAt: stat.mtime.toISOString() };
}

export function listBackups(): BackupInfo[] {
  if (HOSTED) return [];
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .map((name) => {
      const safe = safeName(name);
      if (!safe) return null;
      const full = path.join(BACKUP_DIR, safe);
      const stat = fs.statSync(full);
      return { filename: safe, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .filter((x): x is BackupInfo => x !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteBackup(filename: string): boolean {
  const safe = safeName(filename);
  if (!safe) return false;
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

export function getBackupPath(filename: string): string | null {
  if (HOSTED) return null;
  const safe = safeName(filename);
  if (!safe) return null;
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) return null;
  return full;
}
