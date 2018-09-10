const git = require('..');
const treeLineRe = /^([^ ]+) ([^ ]+) ([^\t]+)\t(.*)/;

class TreeRoot {

    static async read (treeish, git = git) {
        let treeOutput;

        try {
            treeOutput = (await git.lsTree({ 'full-tree': true, r: true }, treeish)).split('\n');
        } catch (err) {
            treeOutput = [];
        }

        const tree = {};
        for (const treeLine of treeOutput) {
            const [, mode, type, hash, path] = treeLineRe.exec(treeLine);

            tree[path] = { mode, type, hash};
        }

        return tree;
    }

    static buildTreeObject (tree) {
        const root = new git.TreeObject();

        for (const treePath of Object.keys(tree).sort()) {
            let pathParts = treePath.split('/');
            let parentNode = root;
            let nodeName;

            while ((nodeName = pathParts.shift()) && pathParts.length > 0) {
                parentNode = parentNode[nodeName] || (parentNode[nodeName] = new git.TreeObject());
            }

            parentNode[nodeName] = tree[treePath];
        }

        return root;
    }
}

module.exports = TreeRoot;
