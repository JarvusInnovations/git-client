class BlobObject {

    static async write (content, git = require('..')) {
        const hashObject = await git.hashObject({ w: true, stdin: true, $spawn: true });

        return hashObject.captureOutputTrimmed(content);
    }

    constructor (hash, mode = '100644') {
        this.hash = hash;
        this.mode = mode;
    }

}

BlobObject.prototype.isBlob = true;

module.exports = BlobObject;
