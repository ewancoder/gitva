#!/usr/bin/env node
/** `npm i -g gitva`, then `gitva` in a repo. */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';
import { serve, type Server } from './server.js';

/**
 * Every flag gitva accepts, with their descriptions for --help.
 */
const FLAGS = {
    port: {
        type: 'string',
        arg: 'P',
        says: 'listen on port P (default: a free one the OS picks)',
    },
    serve: {
        type: 'string',
        arg: '[HOST:PORT]',
        says: 'bind to an interface (default: 0.0.0.0:4200)',
    },
    'no-open': {
        type: 'boolean',
        says: 'do not open a browser',
    },
    learning: {
        type: 'boolean',
        says: 'start with every commit expanded',
    },
    id: {
        type: 'string',
        arg: 'NAME',
        says: "unique id of the recording instead of the folder's path",
    },
    fresh: {
        type: 'boolean',
        says: 'start the recording over',
    },
    help: {
        type: 'boolean',
        short: 'h',
        says: 'print this',
    },
    version: {
        type: 'boolean',
        short: 'v',
        says: 'print the version',
    },
} as const;

/** Width of the first column in --help. */
const COLUMN_WIDTH = 22;

/** One line of --help: how you spell the thing, then what it does. */
const describe = (flag: string, description: string) =>
    `  ${flag.padEnd(COLUMN_WIDTH)}${description}`;

/** Generate --help text. */
const generateHelp = (version: string) =>
    `
gitva ${version} — the visual anatomy of git

usage: gitva [repo] [options]

${describe('repo', 'the repository to watch (default: the directory you are in)')}

options:
${Object.entries(FLAGS)
    .map(([name, flag]) =>
        describe(
            `${'short' in flag ? `-${flag.short}, ` : ''}--${name}${'arg' in flag ? ` ${flag.arg}` : ''}`,
            flag.says,
        ),
    )
    .join('\n')}

gitva never writes to the repository it watches.
https://github.com/ewancoder/gitva
`.trimStart();

export interface Options {
    /** Path to the repository, current folder by default. */
    repo: string;
    /** Listen on port N. */
    port: number;
    /** Bind to an interface like 0.0.0.0:PORT */
    host: string;
    /** Whether to open the browser page. */
    open: boolean;
    /** Start with every commit expanded. */
    learning: boolean;
    /** Start the recording over. */
    fresh: boolean;
    /** Print help. */
    help: boolean;
    /** Print the version. */
    version: boolean;
    /** Unique id of the recording instead of the folder name. */
    id?: string;
}

export function parseArgs(argv: string[]): Options {
    const defaultServeHost = '0.0.0.0';
    const defaultServePort = 4200;
    const defaultServeAddress = `${defaultServeHost}:${defaultServePort}`;
    const serveAddressRegex = /^(.*):(\d+)$/;

    // Generate --serve if not specified.
    const at = argv.indexOf('--serve');
    const address =
        at < 0 || !serveAddressRegex.test(argv[at + 1] ?? '') ? undefined : argv[at + 1];
    const args =
        at < 0
            ? argv
            : [
                  ...argv.slice(0, at),
                  `--serve=${address ?? defaultServeAddress}`,
                  ...argv.slice(address ? at + 2 : at + 1),
              ];

    // Parse arguments.
    const { values, positionals } = nodeParseArgs({ args, options: FLAGS, allowPositionals: true });
    // Fill in the half of a --serve address that was left out.
    const serveAddress =
        values.serve === undefined || serveAddressRegex.test(values.serve)
            ? values.serve
            : `${values.serve}:${defaultServePort}`;
    const bindHostPort = serveAddressRegex.exec(serveAddress ?? '');
    const bindIpAddress = bindHostPort?.[1] ?? '';

    // --port overrides the port of a --serve address, and 4200 is only a default.
    const typedPort = values.port ?? bindHostPort?.[2] ?? '0';
    const port = Number(typedPort);
    // Left to listen(), a NaN or an out-of-range port throws a node internal error
    // naming `options.port` — an option nobody typed. Name the flag they did.
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(
            `${values.port === undefined ? '--serve' : '--port'}: ${typedPort} is not a port — use a whole number from 0 to 65535, or 0 to let the OS pick one`,
        );

    return {
        repo: positionals[0] ?? '.',
        port,
        host: !bindHostPort
            ? '127.0.0.1'
            : bindIpAddress.startsWith('[') && bindIpAddress.endsWith(']')
              ? bindIpAddress.slice(1, -1)
              : bindIpAddress || defaultServeHost,
        open: !values['no-open'],
        help: !!values.help,
        version: !!values.version,
        learning: !!values.learning,
        fresh: !!values.fresh,
        id: values.id,
    };
}

/** Gets the published version. */
export function getVersion(): string {
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}

export async function main(args: string[]): Promise<Server | undefined> {
    const options = parseArgs(args);

    // --version and --help output information and do nothing else.
    if (options.help || options.version) {
        process.stdout.write(options.help ? generateHelp(getVersion()) : `${getVersion()}\n`);
        return undefined;
    }

    const server = await serve(
        options.repo,
        options.port,
        options.host,
        options.learning,
        options.id,
        options.fresh,
    );

    const url = browseUrl(options.host, server.port);

    // Write listening status.
    process.stdout.write(`gitva is watching ${options.repo}\n${url}\n`);
    if (options.host !== '127.0.0.1')
        process.stdout.write(`serving ${options.host}:${server.port}\n`);

    // Open URL in the browser.
    if (options.open) openBrowser(url);

    // Set up closing the server (ctrl+c).
    process.on('SIGINT', () => void stopServer(server));

    return server;
}

export async function stopServer(server: Server): Promise<void> {
    try {
        await server.close();
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}

/** A wildcard bind is not an address to visit; IPv6 literals need URL brackets. */
export function browseUrl(host: string, port: number): string {
    const bindUrl = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `http://${bindUrl.includes(':') ? `[${bindUrl}]` : bindUrl}:${port}/`;
}

function openBrowser(url: string) {
    const cmd = getOpenCommand(process.platform);
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
        .on('error', (error) => {
            process.stderr.write(`could not open browser: ${error.message}\n`);
        })
        .unref();
}

export function getOpenCommand(platform: NodeJS.Platform): string {
    switch (platform) {
        case 'darwin':
            return 'open';
        case 'win32':
            return 'start';
        default:
            return 'xdg-open';
    }
}

/**
 * Gets Node entry path: when running tests it'll be test.js, not cli.js.
 * Also resolves symlinks into full path. */
export function getEntryPath(arg: string): string {
    try {
        return realpathSync(arg);
    } catch {
        return arg; // nothing on disk to resolve; compare what we were given
    }
}

// argv[0] is the Node executable itself /usr/bin/node.
// argv[1] is the path to the cli.js file that's being executed by the Node.
// import.meta.url = file:///path/to/cli.js, always the file with the code,
// not the entry file.
if (process.argv[1] && fileURLToPath(import.meta.url) === getEntryPath(process.argv[1])) {
    // Run this only when it's the main command, not when imported by another file.
    await main(process.argv.slice(2)).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
