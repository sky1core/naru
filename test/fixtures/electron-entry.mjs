import { app } from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appData, entry, ...args] = process.argv.slice(2);
app.setPath('appData', appData);
process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(resolve(entry === '.' ? 'src/main.mjs' : entry)).href);
