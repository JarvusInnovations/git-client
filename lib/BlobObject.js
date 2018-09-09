class BlobObject {

    constructor (hash, mode = '100644') {
        this.hash = hash;
        this.mode = mode;
    }

}

module.exports = BlobObject;
