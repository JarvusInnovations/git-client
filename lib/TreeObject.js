const path = require('path');
const Minimatch = require('minimatch').Minimatch;
const globalGit = require('..');

const treeLineRe = /^([^ ]+) ([^ ]+) ([^\t]+)\t(.*)/;
const minimatchOptions = { dot: true };

// use .changes map to track pending changes on top of cache, null value = delete
// children

const cache = {};

function cacheRead (hash) {
    return cache[hash] || null;
}

function cacheWrite (hash, children) {
    cache[hash] = children;
}


class MergeOptions {
    constructor ({ files = null }) {
        if (files && files.length && (files.length > 1 || files[0] != '**')) {
            this.matchers = files.map(pattern => typeof pattern == 'string' ? new Minimatch(pattern, minimatchOptions) : pattern);
        }
    }
}

class TreeObject {

    static async write (tree, git = globalGit) {
        const lines = [];

        let node;
        for (const nodeName in tree) {
            node = tree[nodeName];

            if (node instanceof TreeObject) {
                lines.push(`040000 tree ${await TreeObject.write(node, git)}\t${nodeName}`);
            } else {
                lines.push(`${node.mode || '100644'} blob ${node.hash}\t${nodeName}`);
            }
        }

        const mktree = await git.mktree({ $spawn: true });

        return mktree.captureOutputTrimmed(lines.join('\n')+'\n');
    }

    constructor ({ hash = null } = {}, git = null) {
        if (git) {
            this.git = git
        }

        this.hash = hash;
        this.$baseChildren = hash ? cacheRead(hash, git) : {};
        this.$children = hash ? Object.setPrototypeOf({}, this.$baseChildren) : {};
        this.dirty = !hash;
    }

    async getHash () {
        if (!this.dirty) {
            return this.hash;
        }

        // TODO: write if needed
    }

    getWrittenHash () {
        return !this.dirty && this.hash || null;
    }

    async $loadBaseChildren () {
        if (!this.hash) {
            this.$baseChildren = {};
            return;
        }

        if (this.$baseChildren) {
            return;
        }

        const git = this.git;

        // read tree data from cache or filesystem
        let cachedHashChildren = cacheRead(this.hash);

        if (!cachedHashChildren) {
            cachedHashChildren = {};

            const treeLines = (await git.catFile({ 'p': true }, this.hash)).split('\n');

            for (const treeLine of treeLines) {
                const [, mode, type, hash, name] = treeLineRe.exec(treeLine);
                cachedHashChildren[name] = { type, hash, mode };
            }

            cacheWrite(this.hash, cachedHashChildren);
        }


        // instantiate children
        const baseChildren = {};

        for (const name in cachedHashChildren) {
            const childCache = cachedHashChildren[name];
            baseChildren[name] = git[childCache.type == 'tree' ? 'createTree' : 'createBlob'](childCache);
        }


        // save to instance and chain beneath children
        this.$baseChildren = baseChildren;
        this.$children = Object.setPrototypeOf({}, baseChildren);
    }

    async write () {
        if (!this.dirty) {
            return this.hash;
        }

        const lines = [];
        for (const name in this.$children) {
            const child = this.$children[name];

            if (child.isTree) {
                lines.push(`040000 tree ${child.dirty ? await child.write() : child.hash}\t${name}`);
            } else {
                lines.push(`${child.mode || '100644'} blob ${child.hash}\t${name}`);
            }
        }

        const mktree = await this.git.mktree({ $spawn: true }); // TODO: use mktree --batch via a queue in git instance

        return mktree.captureOutputTrimmed(lines.join('\n')+'\n');
    }

    async merge (input, options = {}, basePath = '.') {
        // load children of target and input
        if (this.hash && !this.$baseChildren) {
            await this.$loadBaseChildren();
        }

        if (input.hash && !input.$baseChildren) {
            await input.$loadBaseChildren();;
        }


        // initialize options
        if (!(options instanceof MergeOptions)) {
            options = new MergeOptions(options);
        }


        // loop through input children
        const subMerges = [];
        const inputChildren = input.$children;

        childrenLoop: for (const childName in inputChildren) {
            const inputChild = inputChildren[childName];
            let baseChild = this.$children[childName];

            // skip if existing path matches
            if (
                baseChild
                && (!baseChild.dirty && !inputChild.dirty)
                && baseChild.hash == inputChild.hash
            ) {
                continue;
            }

            // test path
            const childPath = path.join(basePath, childName) + (inputChild.isTree ? '/' : '');

            if (options.matchers) {
                let matched = false;

                for (const matcher of options.matchers) {
                    if (matcher.match(childPath)) {
                        if (!matcher.negate) {
                            matched = true;
                        }
                    } else if (matcher.negate) {
                        continue childrenLoop;
                    }
                }

                if (!matched) {
                    continue;
                }
            }

            // if input child is a blob, overwrite with copied ref
            if (inputChild.isBlob) {
                this.$children[childName] = inputChild;
                this.dirty = true;
                continue;
            }

            // if base child isn't a tree, create one
            if (!baseChild || !baseChild.isTree) {
                // if input child is clean, clone it and skip merge
                if (!inputChild.dirty) {
                    this.$children[childName] = new TreeObject({ hash: inputChild.hash }, this.git);
                    this.dirty = true;
                    continue;
                }

                // create an empty tree to merge input into
                baseChild = this.$children[childName] = new TreeObject({ }, this.git);
                this.dirty = true;
            }

            const mergePromise = baseChild.merge(inputChild, options, childPath);

            if (!this.dirty) {
                mergePromise.then(() => {
                    if (baseChild.dirty) {
                        this.dirty = true;
                    }
                });
            }

            subMerges.push(mergePromise);
        }

        return Promise.all(subMerges);
    }
}

TreeObject.treeLineRe = treeLineRe;

TreeObject.prototype.git = globalGit;
TreeObject.prototype.isTree = true;

module.exports = TreeObject;
