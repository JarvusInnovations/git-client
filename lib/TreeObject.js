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

        if (mode != 'overlay' && mode != 'replace') {
            throw new Error(`unknown merge mode "${mode}"`);
        }

        this.mode = mode;
    }
}

class TreeObject {

    constructor ({ hash = EMPTY_TREE_HASH } = {}, git = null) {
        this.dirty = false;
        this.hash = hash;
        this._children = {};
        this._baseChildren = null;

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

    async _loadBaseChildren (preloadChildren = false) {
        if (!this.hash || this.hash == EMPTY_TREE_HASH) {
            Object.setPrototypeOf(this._children, this._baseChildren = {});
            return;
        }

        if (this._baseChildren) {
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
        this._baseChildren = baseChildren;
        this._children = Object.setPrototypeOf({}, baseChildren);
    }

    async getChildren () {
        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren();
        }

        return this._children;
    }

    deleteChild (childName) {
        if (this._children[childName]) {
            this._children[childName] = null;
            this.dirty = true;
        }
    }

    async getSubtree (subtreePath, create = false, returnStack = false) {
        if (subtreePath == '.') {
            return returnStack ? [this] : truee;
        }

        let tree = this,
            parents = [],
            subtreeName,
            nextTree;

        subtreePath = subtreePath.split(path.sep);

        while (tree && subtreePath.length) {
            subtreeName = subtreePath.shift();

            if (tree.hash && !tree._baseChildren) {
                await tree._loadBaseChildren();
            }

            parents.push(tree);
            nextTree = tree._children[subtreeName];

            if (!nextTree) {
                if (!create) {
                    return null;
                }

                nextTree = tree._children[subtreeName] = new TreeObject({ }, this.git);

                for (const parent of parents) {
                    parent.dirty = true;
                }
            }

            tree = nextTree;
        }

        return returnStack ? [...parents, tree] : tree;
    }

    async write () {
        if (!this.dirty) {
            return this.hash;
        }

        const children = this._children;
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

                lines.push({
                    mode: '040000',
                    type: 'tree',
                    hash: treeHash,
                    name
                });
            } else {
                lines.push({
                    mode: child.mode || '100644',
                    type: 'blob',
                    hash: child.hash,
                    name
                });
            }
        }

        this.hash = await this.git.mktreeBatch(lines);

        // flush dirty state
        const baseChildren = this._baseChildren;
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

    async merge (input, options = {}, basePath = '.', preloadChildren = true) {
        // load children of target and input
        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren(preloadChildren);
        }

        if (input.hash && !input._baseChildren) {
            await input._loadBaseChildren(preloadChildren);
        }


        // initialize options
        if (!(options instanceof MergeOptions)) {
            options = new MergeOptions(options);
        }


        // loop through input children
        const subMerges = [];
        const inputChildren = input._children;

        childrenLoop: for (const childName in inputChildren) {

            const inputChild = inputChildren[childName];

            // skip deleted node
            if (!inputChild) {
                continue;
            }


            let baseChild = this._children[childName];

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
                this._children[childName] = inputChild;
                this.dirty = true;
                continue;
            }


            // if base child isn't a tree, create one
            let baseChildEmpty = false;

            if (!baseChild || !baseChild.isTree || options.mode == 'replace') {
                if (pendingChildMatch) {
                    // if file filters are in effect and this child tree has not been matched yet,
                    // finish merging its decendents into an empty tree and skip if it stays empty
                    baseChild = new TreeObject({ }, this.git);
                    await baseChild.merge(inputChild, options, childPath);

                    if (baseChild.dirty) {
                        this._children[childName] = baseChild;
                        this.dirty = true;
                    }

                    continue;
                } else {
                    // if input child is clean, clone it and skip merge
                    if (!inputChild.dirty) {
                        this._children[childName] = new TreeObject({ hash: inputChild.hash }, this.git);
                        this.dirty = true;
                        continue;
                    }

                    // create an empty tree to merge input into
                    baseChild = this._children[childName] = new TreeObject({ }, this.git);
                    this.dirty = true;
                    baseChildEmpty = true;
                }
            }


            // merge child trees
            const mergePromise = baseChild.merge(inputChild, options, childPath, !baseChildEmpty);

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


        // replace-mode should clear all unmatched existing children
        if (options.mode == 'replace') {
            for (const childName in this._children) {
                if (!inputChildren[childName]) {
                    this._children[childName] = null;
                }
            }
        }


        // return aggregate promise for child tree merges
        return Promise.all(subMerges);
    }
}

TreeObject.treeLineRe = treeLineRe;

TreeObject.prototype.git = globalGit;
TreeObject.prototype.isTree = true;

module.exports = TreeObject;
