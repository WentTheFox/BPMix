import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import type { DirectoryEntry, FileRef, GrantedRoot } from '@bpmix/core';
import { discoverRoots } from '../rootDiscovery.js';
import { resolveSafePath, UnsafePathError } from '../pathSafety.js';

function toFileRef(rootId: string, relativePath: string, name: string, sizeBytes: number, lastModifiedMs: number): FileRef {
  return { id: `${rootId}:${relativePath}`, name, relativePath, sizeBytes, lastModifiedMs };
}

/** baseDir is the mounted library base (BPMIX_LIBRARY_ROOT); each top-level subdir is a root. */
export function createLibraryRouter(baseDir: string): Router {
  const router = Router();

  async function findRootOrThrow(rootId: string) {
    const roots = await discoverRoots(baseDir);
    const root = roots.find((r) => r.id === rootId);
    if (!root) {
      const err = new Error(`No library root "${rootId}"`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    return root;
  }

  router.get('/roots', async (_req, res, next) => {
    try {
      const roots = await discoverRoots(baseDir);
      const body: GrantedRoot[] = roots.map((r) => ({ id: r.id, displayName: r.displayName }));
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/roots/:rootId/entries', async (req, res, next) => {
    try {
      const root = await findRootOrThrow(req.params.rootId);
      const relativePath = typeof req.query.path === 'string' ? req.query.path : undefined;
      const dirPath = await resolveSafePath(root.absolutePath, relativePath);
      const prefix = relativePath ? `${relativePath}/` : '';
      const children = await readdir(dirPath, { withFileTypes: true });

      const entries: DirectoryEntry[] = await Promise.all(
        children.map(async (child): Promise<DirectoryEntry> => {
          const childRelativePath = prefix + child.name;
          if (child.isDirectory()) {
            return { type: 'directory', name: child.name, relativePath: childRelativePath };
          }
          const st = await stat(path.join(dirPath, child.name));
          return {
            type: 'file',
            name: child.name,
            relativePath: childRelativePath,
            file: toFileRef(root.id, childRelativePath, child.name, st.size, st.mtimeMs),
          };
        }),
      );
      res.json(entries);
    } catch (err) {
      next(err);
    }
  });

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof UnsafePathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    const status = (err as { status?: number } | null)?.status ?? 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    res.status(status).json({ error: message });
  };
  router.use(handleError);

  return router;
}
