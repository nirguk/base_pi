#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_PATH = path.join('/workspaces/base_pi/.pi', 'projects.json');

function loadRegistry() {
    if (!fs.existsSync(REGISTRY_PATH)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveRegistry(registry) {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Run a docker command via passwordless sudo, returning trimmed stdout or null.
 */
function docker(...args) {
    try {
        const out = execSync(
            `sudo -n docker ${args.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')}`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return out.trim();
    } catch (e) {
        return null;
    }
}

/**
 * Return true if a container (by name) currently exists and is running.
 */
function isRunning(name) {
    const res = docker('inspect', '-f', '{{.State.Running}}', name);
    return res === 'true';
}

/**
 * Resolve a project alias to a live container name.
 *
 * Strategy (handles Docker's transient random container names, which differ
 * from boot to boot while the devcontainer *image* stays vsc-<alias>-*):
 *   1. If the registry's stored container name is currently running, use it.
 *   2. Otherwise, look up a container whose image matches `vsc-<alias>-*`.
 *      Prefer a RUNNING match; fall back to any (stopped) match.
 *   3. If neither resolves, return the stored name (caller reports it).
 *
 * @returns {{ name: string|null, path: string, resolved: boolean }} or null
 *          when the alias is not in the registry (and has no fallback).
 */
function resolveContainer(alias, preferRunning = true) {
    const registry = loadRegistry();
    const info = registry[alias];
    const fallbackName = alias;

    // Best-effort docker lookup by devcontainer image convention: vsc-<alias>-*
    function findByNameOrImage(name) {
        // 1. name matches a running container
        if (name && isRunning(name)) return { name, via: 'name' };
        // 2. image convention: vsc-<alias>-*
        const match = docker(
            'ps', '-a',
            '--format', '{{.Names}}\\t{{.Image}}\\t{{.State}}'
        );
        if (match) {
            const rows = match.split('\n').map(r => {
                const [n, img, state] = r.split('\t');
                return { n, img, running: state === 'running' };
            }).filter(r => r.n && r.img && r.img.includes(`vsc-${alias}-`));
            if (rows.length > 0) {
                const running = rows.find(r => r.running);
                if (running) return { name: running.n, via: 'image', running: true };
                if (!preferRunning) return { name: rows[0].n, via: 'image', running: false };
                // prefer a running match but nothing running under image
                return { name: rows[0].n, via: 'image', running: false };
            }
        }
        return null;
    }

    if (info) {
        const byName = findByNameOrImage(info.container);
        if (byName && byName.name) {
            return { name: byName.name, path: info.path, resolved: true, via: byName.via };
        }
        return { name: info.container, path: info.path, resolved: false, via: 'name' };
    }

    // Not registered: try image convention as a last resort, else alias==name.
    const byImage = findByNameOrImage(null);
    if (byImage && byImage.name) {
        return { name: byImage.name, path: `/workspaces/${alias}`, resolved: true, via: byImage.via };
    }
    return { name: fallbackName, path: `/workspaces/${alias}`, resolved: false, via: 'name' };
}

/**
 * API function to programmatically discover all registered projects.
 * Can be imported into custom Pi Node.js / TypeScript extensions:
 *   const { what_projects } = require('/workspaces/base_pi/.pi/scripts/pi-projects.js');
 */
function what_projects() {
    return loadRegistry();
}

module.exports = { what_projects, resolveContainer, loadRegistry };

// --- CLI Handling ---
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    const subArgs = args.slice(1);

    if (!command) {
        console.error("Usage: pi-projects <register|deregister|list|resolve> [args...]");
        process.exit(1);
    }

    if (command === 'register') {
        const [alias, containerName, customPath] = subArgs;
        if (!alias || !containerName) {
            console.error("Error: Missing arguments.");
            console.error("Usage: pi-projects register <alias> <container-name> [path]");
            process.exit(1);
        }
        const registry = loadRegistry();
        registry[alias] = {
            container: containerName,
            path: customPath || `/workspaces/${alias}`
        };
        saveRegistry(registry);
        console.log(`Successfully registered project: '${alias}' -> container '${containerName}' (path: ${registry[alias].path})`);
    }
    else if (command === 'deregister') {
        const alias = subArgs[0];
        if (!alias) {
            console.error("Error: Missing project alias.");
            console.error("Usage: pi-projects deregister <alias>");
            process.exit(1);
        }
        const registry = loadRegistry();
        if (registry[alias]) {
            delete registry[alias];
            saveRegistry(registry);
            console.log(`Deregistered project: '${alias}'`);
        } else {
            console.error(`Error: Project '${alias}' not found in registry.`);
            process.exit(1);
        }
    }
    else if (command === 'resolve') {
        const alias = subArgs[0];
        if (!alias) {
            console.error("Error: Missing project alias.");
            console.error("Usage: pi-projects resolve <alias>");
            process.exit(1);
        }
        const r = resolveContainer(alias);
        console.log(JSON.stringify(r, null, 2));
    }
    else if (command === 'list') {
        const registry = loadRegistry();
        if (subArgs.includes('--json')) {
            // JSON form: report the LIVE resolved container name, not the stale stored one
            const live = {};
            for (const alias of Object.keys(registry)) {
                const r = resolveContainer(alias);
                live[alias] = {
                    container: r.name,
                    storedContainer: registry[alias].container,
                    path: r.path,
                    resolved: r.resolved,
                    via: r.via
                };
            }
            console.log(JSON.stringify(live, null, 2));
            process.exit(0);
        }
        if (Object.keys(registry).length === 0) {
            console.log("No projects currently registered.");
            process.exit(0);
        }
        console.log(`${'PROJECT ALIAS'.padEnd(20)} ${'CONTAINER NAME'.padEnd(20)} ${'PATH'.padEnd(30)} STATUS`);
        console.log('-'.repeat(80));
        for (const [alias, info] of Object.entries(registry)) {
            const r = resolveContainer(alias);
            let runningState = isRunning(r.name);
            const status = runningState ? '\x1b[32mRunning\x1b[0m' : '\x1b[31mStopped\x1b[0m';
            const shown = r.resolved ? r.name : `${info.container} (stale)`;
            console.log(`${alias.padEnd(20)} ${shown.padEnd(20)} ${r.path.padEnd(30)} ${status}`);
        }
    }
    else {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
}
