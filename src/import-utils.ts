import { getDb } from './db.js';
import { errorMessage } from './errors.js';

export interface ImportResult {
  imported: number;
  duplicated: number;
  skipped: number;
  errors: string[];
}

export function importDelimited(
  raw: string,
  table: string,
  columns: string[],
  rowParser: (parts: string[], line: string) => { values: unknown[] } | { skip: true; reason: string }
): ImportResult {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const db = getDb();
  let imported = 0, duplicated = 0, skipped = 0;
  const errors: string[] = [];

  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);

  for (const line of lines) {
    const parts = line.split('----');
    const result = rowParser(parts, line);
    if ('skip' in result) {
      errors.push(result.reason);
      skipped++;
      continue;
    }
    try {
      const info = stmt.run(...result.values);
      if (info.changes > 0) imported++;
      else duplicated++;
    } catch (e) {
      errors.push(errorMessage(e));
      skipped++;
    }
  }

  return { imported, duplicated, skipped, errors };
}
