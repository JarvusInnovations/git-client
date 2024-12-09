const test = require('ava');
const fs = require('mz/fs');
const path = require('path');
const tmp = require('tmp-promise');
const rmfr = require('rmfr');

const git = require('..');


// locate repo fixtures
const fixtureDir = path.join(__dirname, 'fixture');
const repo1Dir = path.join(fixtureDir, 'repo1');
const repo2Dir = path.join(fixtureDir, 'repo2');


// create secondary instances
const repo2Git = new git.Git({ gitDir: repo2Dir });


// start every test in repo1 dir
test.beforeEach(() => {
    process.chdir(repo1Dir);
});


// declare all tests
test('git version is >=2.7.4', async t => {
    t.true(await git.satisfiesVersion('>=2.7.4'));
});

test('cwd is repo1 fixture', t => {
    t.is(process.cwd(), repo1Dir);
});

test('git module exports constructor and static methods', t => {
    t.is(typeof git, 'function');
    t.is(typeof git.constructor.getGitDirFromEnvironment, 'function');
    t.is(typeof git.constructor.getWorkTreeFromEnvironment, 'function');
});

test('get git dir from environment', async t => {
    t.is(await git.constructor.getGitDirFromEnvironment(), repo1Dir);
});

test('get work tree from environment', async t => {
    t.is(await git.constructor.getWorkTreeFromEnvironment(), null);
});

test('instances have correct gitDir', t => {
    t.is(git.gitDir, null);
    t.is(repo2Git.gitDir, repo2Dir);
});

test('cwd git executes with correct git dir', async t => {
    const gitDir = await git.revParse({ 'git-dir': true });

    t.is(await fs.realpath(gitDir), repo1Dir);
});

test('other git executes with correct git dir',  async t => {
    const gitDir = await repo2Git.revParse({ 'git-dir': true });

    t.is(await fs.realpath(gitDir), repo2Dir);
});

test('other git executes with correct git dir with override', async t => {
    const gitDir = await repo2Git.revParse({ $gitDir: repo1Dir }, { 'git-dir': true });

    t.is(await fs.realpath(gitDir), repo1Dir);
});

test('checkout git repo to temporary directory', async t => {
    const [tmpWorkTree, tmpIndexFilePath] = await Promise.all([tmp.dir(), tmp.tmpName()]);

    try {
        await git.checkout({ $workTree: tmpWorkTree.path, $indexFile: tmpIndexFilePath, force: true }, 'HEAD');

        const stats = await fs.stat(path.join(tmpWorkTree.path, 'README.md'));
        t.truthy(stats);
        t.true(stats.isFile());

        const effectiveWorkTree = await git.revParse({ $workTree: tmpWorkTree.path, 'show-toplevel': true});
        const realEffectiveWorkTree = await fs.realpath(effectiveWorkTree);
        const realTmpWorkTreePath = await fs.realpath(tmpWorkTree.path);

        t.is(path.normalize(realEffectiveWorkTree), path.normalize(realTmpWorkTreePath));

    } finally {
        await Promise.all([
            rmfr(tmpWorkTree.path),
            fs.unlink(tmpIndexFilePath)
        ]);
    }
});

test('can read expected master hash', async t => {
    const masterHash = 'a33bba39aed6d9ecc35b91c96b547937040574f4';

    t.is(await git.showRef({ hash: true }), masterHash);
});
