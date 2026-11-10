#!/usr/bin/env node
// Check the exported snapshot against the manifest shipped with this export.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE-INTEGRITY.json'), 'utf8'));
let failures = 0;
for (const file of manifest.files) {
  try {
    const content = fs.readFileSync(path.join(root, file.export_path));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== file.sha256) {
      failures++;
      console.error(`CHANGED ${file.export_path}`);
    }
  } catch {
    failures++;
    console.error(`MISSING ${file.export_path}`);
  }
}
if (failures) {
  console.error(`Не совпали ${failures} файлов. После намеренных правок это ожидаемо; см. README.`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${manifest.files.length} исходных файлов совпадают со снимком итерации ${manifest.iteration}.`);
}
