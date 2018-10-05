class TreeObject {

    static async write (tree, git = require('..')) {
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

}

TreeObject.prototype.isTree = true;

module.exports = TreeObject;
