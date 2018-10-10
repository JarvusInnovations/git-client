const path = require('path');
const Minimatch = require('minimatch').Minimatch;
const globalGit = require('..');

const treeLineRe = /^([^ ]+) ([^ ]+) ([^\t]+)\t(.*)/;
const minimatchOptions = { dot: true };
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// use .changes map to track pending changes on top of cache, null value = delete
// children

const cache = {};

function cacheRead (hash) {
    if (hash == EMPTY_TREE_HASH) {
        return {};
    }

    return cache[hash] || null;
}

function cacheWrite (hash, children) {
    cache[hash] = children;
}


class MergeOptions {
    constructor ({ files = null, mode = 'overlay' }) {
        if (files && files.length && (files.length > 1 || files[0] != '**')) {
            this.matchers = files.map(pattern => typeof pattern == 'string' ? new Minimatch(pattern, minimatchOptions) : pattern);
        }

        if (mode != 'overlay') {
            throw new Error(`unknown merge mode "${mode}"`);
        }

        this.mode = mode;
    }
}

class TreeObject {

    static async write (tree, git = globalGit) {
        const lines = [];

        let node;
        for (const nodeName in tree) {
            node = tree[nodeName];

            if (!node) {
                continue;
            }

            if (node instanceof TreeObject) {
                const treeHash = await TreeObject.write(node, git);

                if (treeHash == EMPTY_TREE_HASH) {
                    continue;
                }

                lines.push(`040000 tree ${treeHash}\t${nodeName}`);
            } else {
                lines.push(`${node.mode || '100644'} blob ${node.hash}\t${nodeName}`);
            }
        }

        const mktree = await git.mktree({ $spawn: true });

        return mktree.captureOutputTrimmed(lines.join('\n')+'\n');
    }

    constructor ({ hash = EMPTY_TREE_HASH } = {}, git = null) {
        this.dirty = false;
        this.hash = hash;
        this.$children = {};
        this.$baseChildren = null;

        if (git) {
            this.git = git
        }
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

    async $loadBaseChildren (preloadChildren = false) {
        if (!this.hash || this.hash == EMPTY_TREE_HASH) {
            Object.setPrototypeOf(this.$children, this.$baseChildren = {});
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

            const treeLines = (await git.lsTree(preloadChildren ? { r: true, t: true } : {}, this.hash)).split('\n');
            const preloadedTrees = {};

            for (const treeLine of treeLines) {
                const [, mode, type, hash, childPath] = treeLineRe.exec(treeLine);

                if (preloadChildren) {
                    const parentTreePathLength = childPath.lastIndexOf('/');

                    if (type == 'tree') {
                        // any tree listed will have children, begin cache entry
                        preloadedTrees[childPath] = {
                            hash,
                            children: {}
                        };
                    }

                    if (parentTreePathLength == -1) {
                        // direct child, add to current result
                        cachedHashChildren[childPath] = { type, hash, mode };
                    } else {
                        preloadedTrees[childPath.substr(0, parentTreePathLength)]
                            .children[childPath.substr(parentTreePathLength+1)] = { type, hash, mode };
                    }
                } else {
                    cachedHashChildren[childPath] = { type, hash, mode };
                }
            }

            cacheWrite(this.hash, cachedHashChildren);

            if (preloadChildren) {
                for (const treePath in preloadedTrees) {
                    const tree = preloadedTrees[treePath];
                    cacheWrite(tree.hash, tree.children);
                }
            }
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

    async getChildren () {
        if (this.hash && !this.$baseChildren) {
            await this.$loadBaseChildren();
        }

        return this.$children;
    }

    deleteChild (childName) {
        if (this.$children[childName]) {
            this.$children[childName] = null;
            this.dirty = true;
        }
    }

    async getSubtree (subtreePath, create = false) {
        if (subtreePath == '.') {
            return this;
        }

        let tree = this,
            parents = [],
            subtreeName,
            nextTree;

        subtreePath = subtreePath.split(path.sep);

        while (tree && subtreePath.length) {
            subtreeName = subtreePath.shift();

            if (tree.hash && !tree.$baseChildren) {
                await tree.$loadBaseChildren();
            }

            parents.push(tree);
            nextTree = tree.$children[subtreeName];

            if (!nextTree) {
                if (!create) {
                    return null;
                }

                nextTree = tree.$children[subtreeName] = new TreeObject({ }, this.git);

                for (const parent of parents) {
                    parent.dirty = true;
                }
            }

            tree = nextTree;
        }

        return tree;
    }

    async write () {
        if (!this.dirty) {
            return this.hash;
        }

        const children = this.$children;
        const lines = [];
        for (const name in children) {
            const child = children[name];

            if (!child) {
                continue;
            }

            if (child.isTree) {
                const treeHash = child.dirty ? await child.write() : child.hash;

                if (treeHash == EMPTY_TREE_HASH) {
                    continue;
                }

                lines.push(`040000 tree ${treeHash}\t${name}`);
            } else {
                lines.push(`${child.mode || '100644'} blob ${child.hash}\t${name}`);
            }
        }

        const mktree = await this.git.mktree({ $spawn: true }); // TODO: use mktree --batch via a queue in git instance

        this.hash = await mktree.captureOutputTrimmed(lines.join('\n')+'\n');

        // flush dirty state
        const baseChildren = this.$baseChildren;
        for (const childName in children) {
            if (children.hasOwnProperty(childName)) {
                if (!(baseChildren[childName] = children[childName])) {
                    delete baseChildren[childName];
                }
                delete children[childName];
            }
        }
        this.dirty = false;

        return this.hash;
    }

    async merge (input, options = {}, basePath = '.', preloadChildren = false) {
        // load children of target and input
        if (this.hash && !this.$baseChildren) {
            await this.$loadBaseChildren(preloadChildren);
        }

        if (input.hash && !input.$baseChildren) {
            await input.$loadBaseChildren(preloadChildren);
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

            // skip deleted node
            if (!inputChild) {
                continue;
            }


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
            let pendingChildMatch = false;

            if (options.matchers) {
                let matched = false;
                let negationsPossible = false;

                for (const matcher of options.matchers) {
                    if (matcher.match(childPath)) {
                        if (!matcher.negate) {
                            matched = true;
                        }
                    } else if (matcher.negate) {
                        continue childrenLoop;
                    }

                    if (matcher.negate) {
                        negationsPossible = true;
                    }
                }

                if (!matched && inputChild.isBlob) {
                    continue;
                }

                if ((!matched || negationsPossible) && inputChild.isTree) {
                    pendingChildMatch = true;
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
                if (pendingChildMatch) {
                    // if file filters are in effect and this child tree has not been matched yet,
                    // finish merging its decendents into an empty tree and skip if it stays empty
                    baseChild = new TreeObject({ }, this.git);
                    await baseChild.merge(inputChild, options, childPath, true);

                    if (baseChild.dirty) {
                        this.$children[childName] = baseChild;
                        this.dirty = true;
                    }

                    continue;
                } else {
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
            }


            // merge child trees
            const mergePromise = baseChild.merge(inputChild, options, childPath);

            if (!this.dirty) {
                mergePromise.then(() => {
                    if (baseChild.dirty) {
                        this.dirty = true;
                    }
                });
            }


            // build array of promises for child tree merges
            subMerges.push(mergePromise);
        }


        // return aggregate promise for child tree merges
        return Promise.all(subMerges);
    }
}

TreeObject.treeLineRe = treeLineRe;

TreeObject.prototype.git = globalGit;
TreeObject.prototype.isTree = true;

module.exports = TreeObject;
