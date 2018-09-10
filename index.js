const Git = require('./lib/Git.js');


// create a default instance
const git = new Git();


// expose exec function for default instance as export
module.exports = function () {
    return git.exec.apply(git, arguments);
};


// expose default instance as prototype of exported exec function
Object.setPrototypeOf(module.exports, git);


// expose class prototype
module.exports.Git = Git;
module.exports.TreeRoot = require('./lib/TreeRoot.js');
module.exports.TreeObject = require('./lib/TreeObject.js');
module.exports.BlobObject = require('./lib/BlobObject.js');
