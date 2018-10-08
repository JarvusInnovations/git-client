const globalGit = require('..');

class BlobObject {

    static async write (content, git = globalGit) {
        const hashObject = await git.hashObject({ w: true, stdin: true, $spawn: true });

        return hashObject.captureOutputTrimmed(content);
    }

    constructor ({ hash, mode = '100644' }, git = null) {
        this.hash = hash;
        this.mode = mode;

        if (git) {
            this.git = git
        }
    }

}

BlobObject.prototype.git = globalGit;
BlobObject.prototype.isBlob = true;

module.exports = BlobObject;
