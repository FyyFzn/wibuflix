/**
 * Centralized Console Logger for Wibuflix
 * Mengatur dan mengorganisir log terminal & global.memLogs (Admin UI) agar bersih, berwarna (ANSI), dan mudah dibaca.
 */

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    // Colors
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    white: '\x1b[37m'
};

const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
};

global.forceLog = originalConsole.log;
if (!global.memLogs) global.memLogs = [];

function stripAnsi(str) {
    return typeof str === 'string' ? str.replace(/\x1b\[[0-9;]*m/g, '') : str;
}

function getTimeStamp(clean = false) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const msStr = String(now.getMilliseconds()).padStart(3, '0');
    const formatted = `${timeStr}.${msStr}`;
    return clean ? formatted : `${ANSI.gray}${formatted}${ANSI.reset}`;
}

function extractModuleAndCleanArgs(args) {
    if (args.length === 0) return { moduleBadge: '', cleanModule: '', cleanArgs: [] };
    
    let firstArg = args[0];
    if (typeof firstArg === 'string') {
        const match = firstArg.match(/^\[([A-Za-z0-9 _\-:\/\.]+)\]\s*(.*)$/s);
        if (match) {
            const moduleName = match[1];
            const restOfFirstArg = match[2];
            
            let modColor = ANSI.cyan;
            const lowerMod = moduleName.toLowerCase();
            if (lowerMod.includes('error') || lowerMod.includes('fatal')) modColor = ANSI.red;
            else if (lowerMod.includes('warn') || lowerMod.includes('retry')) modColor = ANSI.yellow;
            else if (lowerMod.includes('ok') || lowerMod.includes('ready') || lowerMod.includes('success')) modColor = ANSI.green;
            else if (lowerMod.includes('ffmpeg') || lowerMod.includes('upload') || lowerMod.includes('blob')) modColor = ANSI.magenta;
            else if (lowerMod.includes('pagepool') || lowerMod.includes('browser') || lowerMod.includes('puppeteer')) modColor = ANSI.blue;

            const badge = `${ANSI.bold}${modColor}[${moduleName}]${ANSI.reset}`;
            const cleanModule = `[${moduleName}]`;
            const remainingArgs = restOfFirstArg ? [restOfFirstArg, ...args.slice(1)] : args.slice(1);
            return { moduleBadge: badge, cleanModule, cleanArgs: remainingArgs };
        }
    }
    return { moduleBadge: '', cleanModule: '', cleanArgs: args };
}

function pushToMemLogs(timeClean, levelClean, moduleClean, args) {
    try {
        const argsStr = args.map(a => {
            if (typeof a === 'object' && a !== null) {
                try { return JSON.stringify(a); } catch (e) { return '[Object]'; }
            }
            return stripAnsi(String(a));
        }).join(' ');

        const msg = `${timeClean} [${levelClean}] ${moduleClean ? moduleClean + ' ' : ''}${argsStr}`.trim();
        global.memLogs.push(msg);
        if (global.memLogs.length > 500) global.memLogs.shift();
    } catch (e) {
        // Abaikan error format memLog agar tidak mengganggu sistem utama
    }
}

export function initLogger(options = { productionSilent: false }) {
    console.log = (...args) => {
        const { moduleBadge, cleanModule, cleanArgs } = extractModuleAndCleanArgs(args);
        pushToMemLogs(getTimeStamp(true), 'LOG', cleanModule, cleanArgs);
        
        if (!options.productionSilent) {
            const levelBadge = `${ANSI.blue}ℹ LOG  ${ANSI.reset}`;
            originalConsole.log(`${getTimeStamp()} ${levelBadge} ${moduleBadge}`, ...cleanArgs);
        }
    };

    console.info = (...args) => {
        const { moduleBadge, cleanModule, cleanArgs } = extractModuleAndCleanArgs(args);
        pushToMemLogs(getTimeStamp(true), 'INFO', cleanModule, cleanArgs);
        
        if (!options.productionSilent) {
            const levelBadge = `${ANSI.cyan}ℹ INFO ${ANSI.reset}`;
            originalConsole.info(`${getTimeStamp()} ${levelBadge} ${moduleBadge}`, ...cleanArgs);
        }
    };

    console.warn = (...args) => {
        const { moduleBadge, cleanModule, cleanArgs } = extractModuleAndCleanArgs(args);
        pushToMemLogs(getTimeStamp(true), 'WARN', cleanModule, cleanArgs);
        
        const levelBadge = `${ANSI.yellow}⚠ WARN ${ANSI.reset}`;
        originalConsole.warn(`${getTimeStamp()} ${levelBadge} ${moduleBadge}`, ...cleanArgs);
    };

    console.error = (...args) => {
        const { moduleBadge, cleanModule, cleanArgs } = extractModuleAndCleanArgs(args);
        pushToMemLogs(getTimeStamp(true), 'ERROR', cleanModule, cleanArgs);
        
        const levelBadge = `${ANSI.red}${ANSI.bold}✖ ERROR${ANSI.reset}`;
        originalConsole.error(`${getTimeStamp()} ${levelBadge} ${moduleBadge}`, ...cleanArgs);
    };

    console.debug = (...args) => {
        if (process.env.DEBUG === 'true') {
            const { moduleBadge, cleanModule, cleanArgs } = extractModuleAndCleanArgs(args);
            pushToMemLogs(getTimeStamp(true), 'DEBUG', cleanModule, cleanArgs);
            if (!options.productionSilent) {
                const levelBadge = `${ANSI.gray}🔍 DEBUG${ANSI.reset}`;
                originalConsole.debug(`${getTimeStamp()} ${levelBadge} ${moduleBadge}`, ...cleanArgs);
            }
        }
    };
}

export { originalConsole };
