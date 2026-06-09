import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { REGISTRY_SCHEMA } from "./db-schema-registry";
import { SCHEMA } from "./db-schema";
import { migrateControlPlaneColumns, migrateTasksV2 } from "./db";

export interface DbPool {
  getRegistry(): Database.Database;
  getProject(projectId: string): Database.Database;
  closeProject(projectId: string): void;
  closeAll(): void;
}

export interface DbPoolOptions {
  registryPath?: string;
  resolveProjectDbPath?: (projectId: string) => string;
  maxOpen?: number;
}

const DEFAULT_REGISTRY_PATH = join(homedir(), ".config", "devlog", "registry.sqlite");

export function createDbPool(opts: DbPoolOptions = {}): DbPool {
  const registryPath = opts.registryPath ?? DEFAULT_REGISTRY_PATH;
  let registryDb: Database.Database | null = null;
  const projectDbs = new Map<string, Database.Database>();
  const maxOpen = opts.maxOpen ?? 8;

  function openRegistry(): Database.Database {
    mkdirSync(dirname(registryPath), { recursive: true });
    const db = new Database(registryPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(REGISTRY_SCHEMA);
    return db;
  }

  function openProjectDb(projectId: string, dbPath: string): Database.Database {
    while (projectDbs.size >= maxOpen) {
      const oldestKey = projectDbs.keys().next().value as string;
      const oldestDb = projectDbs.get(oldestKey)!;
      oldestDb.close();
      projectDbs.delete(oldestKey);
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    migrateTasksV2(db);
    migrateControlPlaneColumns(db);
    projectDbs.set(projectId, db);
    return db;
  }

  return {
    getRegistry() {
      if (!registryDb) registryDb = openRegistry();
      return registryDb;
    },
    getProject(projectId) {
      const cached = projectDbs.get(projectId);
      if (cached) {
        // Refresh LRU: delete + re-insert places at end of Map iteration order
        projectDbs.delete(projectId);
        projectDbs.set(projectId, cached);
        return cached;
      }
      if (opts.resolveProjectDbPath) {
        return openProjectDb(projectId, opts.resolveProjectDbPath(projectId));
      }
      // Default: look up registry for project.path, then append /.devlog/devlog.db
      const reg = this.getRegistry();
      const row = reg.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
      if (!row) throw new Error(`Project not found in registry: ${projectId}`);
      return openProjectDb(projectId, join(row.path, ".devlog", "devlog.db"));
    },
    closeProject(projectId) {
      const db = projectDbs.get(projectId);
      if (db) { db.close(); projectDbs.delete(projectId); }
    },
    closeAll() {
      if (registryDb) { registryDb.close(); registryDb = null; }
      for (const db of projectDbs.values()) db.close();
      projectDbs.clear();
    },
  };
}
