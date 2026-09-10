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
 * API function to programmatically discover all registered projects.
 * Can be imported into custom Pi Node.js / TypeScript extensions:
 *   const { what_projects } = require('/workspaces/base_pi/.pi/scripts/pi-projects.js');
 */
function what_projects() {
    return loadRegistry();
}

module.exports = { what_projects };

// --- CLI Handling ---
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    const subArgs = args.slice(1);

    if (!command) {
        console.error("Usage: pi-projects <register|deregister|list> [args...]");
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
    else if (command === 'list') {
        const registry = loadRegistry();
        if (subArgs.includes('--json')) {
            console.log(JSON.stringify(registry, null, 2));
            process.exit(0);
        }
        if (Object.keys(registry).length === 0) {
            console.log("No projects currently registered.");
            process.exit(0);
        }
        console.log(`${'PROJECT ALIAS'.padEnd(20)} ${'CONTAINER NAME'.padEnd(20)} ${'PATH'.padEnd(30)} STATUS`);
        console.log('-'.repeat(80));
        for (const [alias, info] of Object.entries(registry)) {
            let isRunning = false;
            try {
                const res = execSync(`sudo -n docker inspect -f '{{.State.Running}}' ${info.container}`, { encoding: 'utf8' });
                isRunning = res.trim() === 'true';
            } catch (e) {
                isRunning = false;
            }
            const status = isRunning ? '\x1b[32mRunning\x1b[0m' : '\x1b[31mStopped\x1b[0m';
            console.log(`${alias.padEnd(20)} ${info.container.padEnd(20)} ${info.path.padEnd(30)} ${status}`);
        }
    }
    else {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
}