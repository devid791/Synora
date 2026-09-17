import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, 'release.json'), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19))
  throw Error('Synora Web requires Node.js 22.19 or newer.');
if (manifest.target !== `${process.platform}-${process.arch}`)
  throw Error(`This web package is for ${manifest.target}, not ${process.platform}-${process.arch}.`);
// Trusted native host setup, just as the Electron host supplies resourcesPath.
// Paths derive from the extracted package, never from HTTP/UI input or cwd.
process.resourcesPath = join(here, 'resources');
process.env.PLAYWRIGHT_BROWSERS_PATH = join(here, 'resources/browser');
console.log(`Synora Web ${manifest.version} (${manifest.sourceCommit.slice(0, 7)})`);
await import('./server.mjs');
