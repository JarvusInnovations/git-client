const globalGit = require('..');

class BlobObject {

    static async write (content, git = globalGit) {
        const hashObject = await git.hashObject({ w: true, stdin: true, $spawn: true });

        return hashObject.captureOutputTrimmed(content);
    }

    constructor ({ hash, mode = '100644' }, git = null) {
        if (git) {
            this.git = git
        }

        this.hash = hash;
        this.mode = mode;
    }

}

BlobObject.prototype.git = globalGit;
BlobObject.prototype.isBlob = true;

module.exports = BlobObject;
