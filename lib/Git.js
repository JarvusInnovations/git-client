const semver = require('semver');
const fs = require('mz/fs');
const nodeCleanup = require('node-cleanup');
const child_process = require('child_process');
const logger = require('./logger');


const hashRe = /^[a-fA-F0-9]{40}$/;


/**
 * Represents and provides an interface to an executable git binary
 * available in the host environment
 */
class Git {

    constructor ({ command = null, gitDir = null, workTree = null, indexFile = null } = {}) {
        this.command = command || this.command;

        if (gitDir) {
            this.gitDir = gitDir;
        }

        if (workTree) {
            this.workTree = workTree;
        }

        if (indexFile) {
            this.indexFile = indexFile;
        }

        this.version = null;
    }

    /**
     * @static
     * Gets complete path to git directory
     */
    static async getGitDirFromEnvironment () {
        const gitDir = await Git.prototype.exec('rev-parse', { 'git-dir': true });

        return await fs.realpath(gitDir);
    }


    /**
     * @static
     * Gets complete path to working tree
     */
    static async getWorkTreeFromEnvironment () {
        const workTree = await Git.prototype.exec('rev-parse', { 'show-toplevel': true });

        return await workTree ? fs.realpath(workTree) : Promise.resolve(null);
    };


    /**
     * Gets the effective git directory
     * @returns {string} Path to .git directory
     */
    async getGitDir () {
        return this.gitDir || Git.getGitDirFromEnvironment();
    }

    /**
     * Gets the effective working tree
     * @returns {string} Path to working tree
     */
    async getWorkTree () {
        return this.workTree || Git.getWorkTreeFromEnvironment();
    }

    /**
     * Gets the effective index
     * @returns {string} Path to working tree
     */
    async getIndexPath () {
        return this.indexFile || await this.revParse({ 'git-path': true }, 'index');
    }

    /**
     * Get the version of the hab binary
     * @returns {?string} Version reported by git binary, or null if not available
     */
    async getVersion () {
        if (this.version === null) {
            try {
                const output = await this.exec({ version: true });
                [, this.version] = /^git version (\d+\.\d+\.\d+)/.exec(output);
            } catch (err) {
                this.version = false;
            }
        }

        return this.version || null;
    }

    /**
     * Check if git version is satisfied
     * @param {string} range - The version or range git should satisfy (see https://github.com/npm/node-semver#ranges)
     * @returns {boolean} True if git version satisfies provided range
     */
    async satisfiesVersion (range) {
        return semver.satisfies(await this.getVersion(), range);
    }

    /**
     * Ensure that git version is satisfied
     * @param {string} range - The version or range git should satisfy (see https://github.com/npm/node-semver#ranges)
     * @returns {Git} Returns current instance or throws exception if version range isn't satisfied
     */
    async requireVersion (range) {
        if (!await this.satisfiesVersion(range)) {
            throw new Error(`Git version must be ${range}, reported version is ${await this.getVersion()}`);
        }

        return this;
    }

    /**
     * Reads a set from a config file within the git directory
     * @param {string} configPath - Path to the config file within GIT_DIR
     */
    async readConfigSet (configPath) {
        const gitDir = await this.getGitDir();
        return await fs.exists(`${gitDir}/${configPath}`)
            ? new Set((await fs.readFile(`${gitDir}/${configPath}`, 'ascii')).trim().split('\n'))
            : new Set();
    }

    /**
     * WRites a set to a config file within the git directory
     * @param {string} configPath - Path to the config file within GIT_DIR
     * @param {Set} set - Set of values to write to the file
     */
    async writeConfigSet (configPath, set) {
        const gitDir = await this.getGitDir();
        await fs.writeFile(`${gitDir}/${configPath}`, Array.from(set.values()).join('\n')+'\n');
    }

    /**
     * Adds one or more items to a set
     * @param {string} configPath - Path to the config file within GIT_DIR
     * @param  {...string} items - Value or values to add
     */
    async addToConfigSet (configPath, ...items) {
        const set = await this.readConfigSet(configPath);
        for (const item of items) {
            set.add(item);
        }
        await this.writeConfigSet(configPath, set);
        return set;
    }

    /**
     * Removes one or more items to a set
     * @param {string} configPath - Path to the config file within GIT_DIR
     *  @param  {...string} items - Value or values to remove
     */
    async removeFromConfigSet (configPath, ...items) {
        const set = await this.readConfigSet(configPath);
        for (const item of items) {
            set.delete(item);
        }
        await this.writeConfigSet(configPath, set);
        return set;
    }

    /**
     * Tests if given string looks like a valid hash
     */
    isHash (hash) {
        return hashRe.test(hash);
    }

    /**
     * Gets tree hash for a given ref
     * @param {string} ref Any commit ref
     */
    async getTreeHash (ref) {
        return this.revParse({ verify: true }, `${ref}^{tree}`);
    }

    /**
     * Executes mktree in batch mode
     */
    async mktreeBatch(children) {

        if (!this._mktreeBatchQueue) {
            this._mktreeBatchQueue = [];
        }

        if (!this._mktreeBatchProcess) {
            this._mktreeBatchProcess = await this.mktree({ batch: true, $spawn: true });

            this._mktreeBatchProcess.stdout.on('data', data => {
                const currentJob = this._mktreeBatchQueue[0];

                currentJob.output.push(data);

                if (data.includes('\n')) {
                    this._mktreeBatchQueue.shift();
                    const output = currentJob.output.join('').trim();
                    logger.debug('git mktree --batch -> %s', output);
                    currentJob.resolve(output);
                }
            });

            this._mktreeBatchProcess.stderr.on('data', data => {
                this._mktreeBatchQueue[0].error.push(data);
            });

            this._mktreeBatchProcess.on('exit', code => {
                this._mktreeBatchProcess = null;

                const currentJob = this._mktreeBatchQueue.shift();

                if (code == 0) {
                    if (currentJob) {
                        currentJob.resolve(currentJob.output.join('').trim());
                    }
                } else {
                    const err = new Error('mktree failed: '+currentJob.error.join('').trim());
                    err.output = currentJob.output.join('').trim();
                    err.code = code;

                    if (currentJob) {
                        currentJob.reject(err);
                    } else {
                        throw err;
                    }
                }
            });

            nodeCleanup(() => this.cleanup);
        }

        if (this._mktreeBatchTimeout) {
            clearTimeout(this._mktreeBatchTimeout);
        }

        return new Promise((resolve, reject) => {
            this._mktreeBatchProcess.stdin.write(
                children
                    .map(({ mode, type, hash, name }) => `${mode} ${type} ${hash}\t${name}`)
                    .join('\n')
                +'\n\n'
            );

            this._mktreeBatchTimeout = setTimeout(() => this._mktreeBatchProcess.stdin.end(), 1000);

            this._mktreeBatchQueue.push({ resolve, reject, output: [], error: [] });
        });
    }

    /**
     * Immediately clean up any open batches
     */
    cleanup () {
        if (this._mktreeBatchTimeout) {
            clearTimeout(this._mktreeBatchTimeout);
        }

        if (this._mktreeBatchProcess) {
            this._mktreeBatchProcess.stdin.end();
        }
    }


    /**
     * Executes git with given arguments
     * @param {string|string[]} args - Arguments to execute
     * @param {?Object} execOptions - Extra execution options
     * @returns {Promise}
     */
    async exec (...args) {
        let command;
        const commandArgs = [];
        const commandEnv = {};
        const execOptions = {
            gitDir: this.gitDir,
            workTree: this.workTree,
            maxBuffer: 1024 * 1024 * 5 // 5 MB output buffer
        };

        if (this.indexFile) {
            commandEnv.GIT_INDEX_FILE = this.indexFile;
        }

        // scan through all arguments
        let arg;

        while (arg = args.shift()) {
            switch (typeof arg) {
                case 'string':
                    if (!command) {
                        command = arg; // the first string is the command
                        break;
                    }
                    // fall through and get pushed with numbers
                case 'number':
                    commandArgs.push(arg.toString());
                    break;
                case 'object':

                    // clone before deleting processed keys
                    arg = Object.assign({}, arg);


                    // extract any git options
                    if ('$gitDir' in arg) {
                        execOptions.gitDir = arg.$gitDir;
                        delete arg.$gitDir;
                    }

                    if ('$workTree' in arg) {
                        execOptions.workTree = arg.$workTree;
                        delete arg.$workTree;
                    }

                    if ('$indexFile' in arg) {
                        commandEnv.GIT_INDEX_FILE = arg.$indexFile;
                        delete arg.$indexFile;
                    }


                    // extract any general execution options
                    if ('$nullOnError' in arg) {
                        execOptions.nullOnError = arg.$nullOnError;
                        delete arg.$nullOnError;
                    }

                    if ('$spawn' in arg) {
                        execOptions.spawn = arg.$spawn;
                        delete arg.$spawn;
                    }

                    if ('$shell' in arg) {
                        execOptions.shell = arg.$shell;
                        delete arg.$shell;
                    }

                    if ('$cwd' in arg) {
                        execOptions.cwd = arg.$cwd;
                        delete arg.$cwd;
                    }

                    if ('$env' in arg) {
                        for (let key in arg.$env) {
                            commandEnv[key] = arg.$env[key];
                        }
                        delete arg.$env;
                    }

                    if ('$preserveEnv' in arg) {
                        execOptions.preserveEnv = arg.$preserveEnv;
                        delete arg.$preserveEnv;
                    }

                    if ('$options' in arg) {
                        for (let key in arg.$options) {
                            execOptions[key] = arg.$options[key];
                        }
                        delete arg.$options;
                    }

                    if ('$passthrough' in arg) {
                        if (execOptions.passthrough = Boolean(arg.$passthrough)) {
                            execOptions.spawn = true;
                        }
                        delete arg.$passthrough;
                    }

                    if ('$wait' in arg) {
                        execOptions.wait = Boolean(arg.$wait);
                        delete arg.$wait;
                    }


                    // any remaiing elements are args/options
                    commandArgs.push.apply(commandArgs, Array.isArray(arg) ? arg : Git.cliOptionsToArgs(arg));
                    break;
                default:
                    throw 'unhandled exec argument';
            }
        }


        // prefixs args with command
        if (command) {
            commandArgs.unshift(command);
        }


        // prefix args with git-level options
        const gitOptions = {};

        if (execOptions.gitDir) {
            gitOptions['git-dir'] = execOptions.gitDir;
        }

        if (execOptions.workTree) {
            gitOptions['work-tree'] = execOptions.workTree;
        }

        commandArgs.unshift.apply(commandArgs, Git.cliOptionsToArgs(gitOptions));


        // prepare environment
        if (execOptions.preserveEnv !== false) {
            Object.setPrototypeOf(commandEnv, process.env);
        }

        execOptions.env = commandEnv;


        // execute git command
        logger.debug(this.command, commandArgs.join(' '));

        if (execOptions.spawn) {
            const process = child_process.spawn(this.command, commandArgs, execOptions);

            if (execOptions.passthrough) {
                process.stdout.on('data', data => data.toString().trim().split(/\n/).forEach(line => logger.info(line)));
                process.stderr.on('data', data => data.toString().trim().split(/\n/).forEach(line => logger.error(line)));
            }

            if (execOptions.wait) {
                return new Promise((resolve, reject) => {
                    process.on('exit', code => {
                        if (code == 0) {
                            resolve();
                        } else {
                            reject(code);
                        }
                    });
                });
            }

            let capturePromise;
            process.captureOutput = (input = null) => {
                if (!capturePromise) {
                    capturePromise = new Promise((resolve, reject) => {
                        let output = '', error = '';

                        process.stdout.on('data', data => {
                            output += data;
                        });

                        process.stderr.on('data', data => {
                            error += data;
                        });

                        process.on('exit', code => {
                            if (code == 0) {
                                resolve(output);
                            } else {
                                if (error) {
                                    logger.error(error);
                                }

                                reject({ output, code, error });
                            }
                        });
                    });
                }

                if (input) {
                    process.stdin.write(input);
                    process.stdin.end();
                }

                return capturePromise;
            };

            process.captureOutputTrimmed = async (input = null) => {
                return (await process.captureOutput(input)).trim();
            };

            return process;
        } else if (execOptions.shell) {
            return new Promise((resolve, reject) => {
                child_process.exec(`${this.command} ${commandArgs.join(' ')}`, execOptions, (error, stdout, stderr) => {
                    if (error) {
                        if (execOptions.nullOnError) {
                            return resolve(null);
                        } else {
                            error.stderr = stderr;
                            return reject(error);
                        }
                    }

                    resolve(stdout.trim());
                });
            });
        } else {
            return new Promise((resolve, reject) => {
                child_process.execFile(this.command, commandArgs, execOptions, (error, stdout, stderr) => {
                    if (error) {
                        if (execOptions.nullOnError) {
                            return resolve(null);
                        } else {
                            error.stderr = stderr;
                            return reject(error);
                        }
                    }

                    resolve(stdout.trim());
                });
            });
        }
    }

    /**
     * @private
     * Convert an options object into CLI arguments string
     */
    static cliOptionsToArgs (options) {
        var args = [],
            key, option, val;

        for (key in options) {
            option = options[key];

            for (val of Array.isArray(option) ? option : [option]) {
                if (key.length == 1) {
                    if (val === true) {
                        args.push('-'+key);
                    } else if (val !== false && val !== null && val !== undefined) {
                        args.push('-'+key, val);
                    }
                } else {
                    if (val === true) {
                        args.push('--'+key);
                    } else if (val !== false && val !== null && val !== undefined) {
                        args.push('--'+key+'='+val);
                    }
                }
            }
        }

        return args;
    }
}


// set default git command
Git.prototype.command = 'git';


// add first-class methods for common git subcommands
[
    'add',
    'am',
    'annotate',
    'apply',
    'archive',
    'bisect--helper',
    'bisect',
    'blame',
    'branch',
    'bundle',
    'cat-file',
    'check-attr',
    'check-ignore',
    'check-mailmap',
    'check-ref-format',
    'checkout-index',
    'checkout',
    'cherry-pick',
    'cherry',
    'clean',
    'clone',
    'column',
    'commit-tree',
    'commit',
    'config',
    'count-objects',
    'credential-cache--daemon',
    'credential-cache',
    'credential-osxkeychain',
    'credential-store',
    'credential',
    'daemon',
    'describe',
    'diff-files',
    'diff-index',
    'diff-tree',
    'diff',
    'difftool--helper',
    'difftool',
    'fast-export',
    'fast-import',
    'fetch-pack',
    'fetch',
    'filter-branch',
    'fmt-merge-msg',
    'for-each-ref',
    'format-patch',
    'fsck-objects',
    'fsck',
    'gc',
    'get-tar-commit-id',
    'grep',
    'gui--askpass',
    'hash-object',
    'help',
    'http-backend',
    'http-fetch',
    'http-push',
    'imap-send',
    'index-pack',
    'init-db',
    'init',
    'instaweb',
    'interpret-trailers',
    'log',
    'ls-files',
    'ls-remote',
    'ls-tree',
    'mailinfo',
    'mailsplit',
    'merge-base',
    'merge-file',
    'merge-index',
    'merge-octopus',
    'merge-one-file',
    'merge-ours',
    'merge-recursive',
    'merge-resolve',
    'merge-subtree',
    'merge-tree',
    'merge',
    'mergetool',
    'mktag',
    'mktree',
    'mv',
    'name-rev',
    'notes',
    'p4',
    'pack-objects',
    'pack-redundant',
    'pack-refs',
    'patch-id',
    'prune-packed',
    'prune',
    'pull',
    'push',
    'quiltimport',
    'read-tree',
    'rebase--helper',
    'rebase',
    'receive-pack',
    'reflog',
    'remote-ext',
    'remote-fd',
    'remote-ftp',
    'remote-ftps',
    'remote-http',
    'remote-https',
    'remote-testsvn',
    'remote',
    'repack',
    'replace',
    'request-pull',
    'rerere',
    'reset',
    'rev-list',
    'rev-parse',
    'revert',
    'rm',
    'send-email',
    'send-pack',
    'sh-i18n--envsubst',
    'shell',
    'shortlog',
    'show-branch',
    'show-index',
    'show-ref',
    'show',
    'stage',
    'stash',
    'status',
    'stripspace',
    'submodule--helper',
    'submodule',
    'subtree',
    'svn',
    'symbolic-ref',
    'tag',
    'unpack-file',
    'unpack-objects',
    'update-index',
    'update-ref',
    'update-server-info',
    'upload-archive',
    'upload-pack',
    'var',
    'verify-commit',
    'verify-pack',
    'verify-tag',
    'web--browse',
    'whatchanged',
    'worktree',
    'write-tree'
].forEach(command => {
    const method = command.replace(/-([a-zA-Z])/, (match, letter) => letter.toUpperCase());

    Git.prototype[method] = function (...args) {
        args.unshift(command);
        return this.exec.apply(this, args);
    };
});


// export class
module.exports = Git;
