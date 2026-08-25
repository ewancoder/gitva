/**
 * A static server for the sample, because a browser will not import a module
 * off `file://`. Twenty lines rather than a dependency — it serves this folder
 * and the package the import map in index.html points into.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
};
const PORT = 5173;

createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = resolve(HERE, `.${path === '/' ? '/index.html' : path}`);
    // The one thing a static server must get right: a request cannot climb out
    // of the folder it is served from.
    if (!file.startsWith(HERE)) return void res.writeHead(403).end('no');
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
