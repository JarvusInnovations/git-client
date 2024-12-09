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

test('handles stdout line callback', async t => {
    const lines = [];
    const process = await git.log({
        $onStdout: line => lines.push(line),
        n: 1
    });

    await new Promise(resolve => process.on('exit', resolve));

    t.true(lines.length > 0);
    t.true(lines[0].includes('commit'));
});

test('handles stderr line callback', async t => {
    const errors = [];
    const process = await git.revParse({
        $onStderr: line => errors.push(line),
        verify: true
    }, 'invalid-ref');

    await t.throwsAsync(
        () => new Promise((resolve, reject) => {
            process.on('exit', code => code === 0 ? resolve() : reject(new Error(`Exit code: ${code}`)));
        })
    );

    t.true(errors.length > 0);
    t.true(errors[0].includes('fatal'));
});

test('stdout and stderr callbacks work together', async t => {
    const output = [];
    const errors = [];

    const process = await git.log({
        $onStdout: line => output.push(`out: ${line}`),
        $onStderr: line => errors.push(`err: ${line}`),
        n: 1
    });

    await new Promise(resolve => process.on('exit', resolve));

    t.true(output.length > 0);
    t.true(output[0].startsWith('out: commit'));
    t.is(errors.length, 0);
});

test('preserves leading spaces in porcelain status', async t => {
    // Create a temporary directory
    const tmpDir = await tmp.dir();
    const gitDir = path.join(tmpDir.path, '.git');

    try {
        // Initialize a new git repo
        await git.init({ $gitDir: gitDir });

        // Create a git instance
        const testGit = new git.Git({ gitDir });

        // Create and commit a file first
        const testFile = path.join(tmpDir.path, 'test.txt');
        await fs.writeFile(testFile, 'initial content');
        await testGit.add({ $workTree: tmpDir.path }, testFile);
        await testGit.commit({ $workTree: tmpDir.path }, '-m', 'Initial commit');

        // Modify the file to get a modified status with leading space
        await fs.writeFile(testFile, 'modified content');

        // Get status with porcelain format using spawn mode (preserves spaces)
        const spawnStatus = await testGit.status({
            $workTree: tmpDir.path,
            porcelain: true,
            $spawn: true
        });
        const rawSpawnOutput = await spawnStatus.captureOutput();

        // Get status with porcelain format using regular mode
        const regularStatus = await testGit.status({
            $workTree: tmpDir.path,
            porcelain: true
        });

        // Both modes should preserve the leading space in ' M test.txt'
        t.true(rawSpawnOutput.includes(' M test.txt'));
        t.true(regularStatus.includes(' M test.txt'));

    } finally {
        await rmfr(tmpDir.path);
    }
});
