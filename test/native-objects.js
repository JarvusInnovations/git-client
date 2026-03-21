const test = require('ava');
const fs = require('mz/fs');
const path = require('path');
const tmp = require('tmp-promise');
const rmfr = require('rmfr');

const git = require('..');


// each test gets a fresh temp repo
async function createTempRepo() {
    const tmpDir = await tmp.dir();
    const gitDir = path.join(tmpDir.path, '.git');

    await git.init({ $gitDir: gitDir });

    const testGit = new git.Git({ gitDir });
    await testGit.config('user.email', 'test@test.com');
    await testGit.config('user.name', 'Test');

    return { tmpDir, gitDir, testGit };
}


// $putBlob
test('$putBlob matches git hash-object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = 'hello world\n';
        const nativeHash = await testGit.$putBlob(content, { write: false });
        const proc = await testGit.hashObject({ w: true, stdin: true, $spawn: true });
        const gitHash = await proc.captureOutputTrimmed(content);

        t.is(nativeHash, gitHash);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putBlob creates readable object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = 'test content for write\n';
        const hash = await testGit.$putBlob(content, { write: true });

        // git should be able to read it back
        const readBack = await testGit.catFile({ p: true }, hash);
        t.is(readBack, content.trimEnd());
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putBlob skips known objects', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = 'duplicate content\n';
        testGit.$resetStats();

        await testGit.$putBlob(content, { write: true });
        t.is(testGit.$stats.objectsWritten, 1);

        await testGit.$putBlob(content, { write: true });
        t.is(testGit.$stats.objectsWritten, 1);
        t.is(testGit.$stats.objectsCached, 1);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putBlob handles binary content', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
        const hash = await testGit.$putBlob(content, { write: true });
        t.truthy(testGit.isHash(hash));

        // verify git can read it
        await t.notThrowsAsync(() => testGit.catFile({ t: true }, hash));
    } finally {
        await rmfr(tmpDir.path);
    }
});


// $putTree
test('$putTree matches git mktree for simple tree', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob1 = await testGit.$putBlob('file1\n', { write: true });
        const blob2 = await testGit.$putBlob('file2\n', { write: true });

        const children = [
            { mode: '100644', type: 'blob', hash: blob1, name: 'alpha.txt' },
            { mode: '100644', type: 'blob', hash: blob2, name: 'beta.txt' }
        ];

        const nativeHash = await testGit.$putTree(children);
        const gitHash = await testGit.mktreeBatch(children);

        t.is(nativeHash, gitHash);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putTree matches git mktree with mixed types', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('content\n', { write: true });

        // create a subtree via git mktree
        const subChildren = [{ mode: '100644', type: 'blob', hash: blob, name: 'nested.txt' }];
        const subTree = await testGit.mktreeBatch(subChildren);

        const children = [
            { mode: '100644', type: 'blob', hash: blob, name: 'file.txt' },
            { mode: '040000', type: 'tree', hash: subTree, name: 'subdir' },
            { mode: '100755', type: 'blob', hash: blob, name: 'script.sh' }
        ];

        const nativeHash = await testGit.$putTree(children);
        const gitHash = await testGit.mktreeBatch(children);

        t.is(nativeHash, gitHash);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putTree handles git tree sort order correctly', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('x\n', { write: true });
        const subChildren = [{ mode: '100644', type: 'blob', hash: blob, name: 'x' }];
        const subTree = await testGit.mktreeBatch(subChildren);

        // entries that sort differently with vs without trailing / rule
        const children = [
            { mode: '100644', type: 'blob', hash: blob, name: 'foo.txt' },
            { mode: '040000', type: 'tree', hash: subTree, name: 'foo' },
            { mode: '100644', type: 'blob', hash: blob, name: 'foo-bar' },
        ];

        const nativeHash = await testGit.$putTree(children);
        const gitHash = await testGit.mktreeBatch(children);

        t.is(nativeHash, gitHash);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putTree normalizes mode (040000 -> 40000)', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('content\n', { write: true });
        const subTree = await testGit.mktreeBatch([
            { mode: '100644', type: 'blob', hash: blob, name: 'file.txt' }
        ]);

        const children = [
            { mode: '040000', type: 'tree', hash: subTree, name: 'dir' }
        ];

        const nativeHash = await testGit.$putTree(children);
        const gitHash = await testGit.mktreeBatch(children);

        t.is(nativeHash, gitHash);
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putTree result is readable by git ls-tree', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('hello\n', { write: true });

        const children = [
            { mode: '100644', type: 'blob', hash: blob, name: 'greeting.txt' }
        ];

        const hash = await testGit.$putTree(children);
        const lsOutput = await testGit.lsTree({}, hash);

        t.true(lsOutput.includes('greeting.txt'));
        t.true(lsOutput.includes(blob));
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$putTree caches known objects', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('cached\n', { write: true });

        const children = [
            { mode: '100644', type: 'blob', hash: blob, name: 'file.txt' }
        ];

        testGit.$resetStats();
        const hash1 = await testGit.$putTree(children);
        t.is(testGit.$stats.objectsWritten, 1);

        const hash2 = await testGit.$putTree(children);
        t.is(hash1, hash2);
        t.is(testGit.$stats.objectsWritten, 1);
        t.is(testGit.$stats.objectsCached, 1);
    } finally {
        await rmfr(tmpDir.path);
    }
});


// $knownObjects cache
test('$knowObject and $isKnownObject work correctly', t => {
    const testGit = new git.Git({ gitDir: '/dev/null' });

    t.false(testGit.$isKnownObject('abc123'));
    testGit.$knowObject('abc123');
    t.true(testGit.$isKnownObject('abc123'));
});

test('$resetStats clears counters but not knownObjects', t => {
    const testGit = new git.Git({ gitDir: '/dev/null' });

    testGit.$stats.exec = 5;
    testGit.$knowObject('abc');
    testGit.$resetStats();

    t.is(testGit.$stats.exec, 0);
    t.true(testGit.$isKnownObject('abc'));
});


// $writeLooseObject
test('$writeLooseObject creates correct path structure', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = 'loose object test\n';
        const hash = await testGit.$putBlob(content, { write: true });

        const objPath = path.join(tmpDir.path, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
        t.true(await fs.exists(objPath));
    } finally {
        await rmfr(tmpDir.path);
    }
});

test('$writeLooseObject is idempotent', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = Buffer.from('blob 5\0hello');
        const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

        // clear known objects to force both writes to hit disk
        testGit._knownObjects.clear();
        await testGit.$writeLooseObject(hash, content);
        // should not throw on second write
        testGit._knownObjects.clear();
        await t.notThrowsAsync(() => testGit.$writeLooseObject(hash, content));
    } finally {
        await rmfr(tmpDir.path);
    }
});


// $getBlob
test('$getBlob reads blob content', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = 'hello from getBlob\n';
        const hash = await testGit.$putBlob(content);
        const result = await testGit.$getBlob(hash);

        t.is(result, content);
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$getBlob returns null for missing object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const result = await testGit.$getBlob('0000000000000000000000000000000000000000');
        t.is(result, null);
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$getBlob handles binary content', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const content = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
        const hash = await testGit.$putBlob(content);

        // $getBlob returns string, so read via $readObject for binary
        const result = await testGit.$readObject(hash);
        t.deepEqual(result.content, content);
        t.is(result.type, 'blob');
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});


// $getTree
test('$getTree reads tree entries', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob1 = await testGit.$putBlob('file1\n');
        const blob2 = await testGit.$putBlob('file2\n');

        const treeHash = await testGit.$putTree([
            { mode: '100644', type: 'blob', hash: blob1, name: 'alpha.txt' },
            { mode: '100644', type: 'blob', hash: blob2, name: 'beta.txt' }
        ]);

        const entries = await testGit.$getTree(treeHash);

        t.is(entries.length, 2);
        t.is(entries[0].name, 'alpha.txt');
        t.is(entries[0].hash, blob1);
        t.is(entries[0].mode, '100644');
        t.is(entries[0].type, 'blob');
        t.is(entries[1].name, 'beta.txt');
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$getTree handles mixed types and normalizes modes', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('content\n');
        const subTree = await testGit.$putTree([
            { mode: '100644', type: 'blob', hash: blob, name: 'nested.txt' }
        ]);

        const treeHash = await testGit.$putTree([
            { mode: '100644', type: 'blob', hash: blob, name: 'file.txt' },
            { mode: '040000', type: 'tree', hash: subTree, name: 'subdir' }
        ]);

        const entries = await testGit.$getTree(treeHash);
        const treeEntry = entries.find(e => e.name === 'subdir');

        t.is(treeEntry.type, 'tree');
        t.is(treeEntry.mode, '040000');
        t.is(treeEntry.hash, subTree);
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$getTree populates known-objects cache', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const blob = await testGit.$putBlob('cached\n');
        const treeHash = await testGit.$putTree([
            { mode: '100644', type: 'blob', hash: blob, name: 'file.txt' }
        ]);

        // clear cache to test that $getTree repopulates it
        testGit._knownObjects.clear();
        t.false(testGit.$isKnownObject(blob));

        await testGit.$getTree(treeHash);
        t.true(testGit.$isKnownObject(blob));
        t.true(testGit.$isKnownObject(treeHash));
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$getTree returns null for missing object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const result = await testGit.$getTree('0000000000000000000000000000000000000000');
        t.is(result, null);
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});


// $objectExists
test('$objectExists returns type for existing object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const hash = await testGit.$putBlob('exists\n');
        // clear cache to force actual check
        testGit._knownObjects.clear();
        const result = await testGit.$objectExists(hash);

        t.is(result, 'blob');
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$objectExists returns null for missing object', async t => {
    const { tmpDir, testGit } = await createTempRepo();

    try {
        const result = await testGit.$objectExists('0000000000000000000000000000000000000000');
        t.is(result, null);
    } finally {
        testGit.cleanup();
        await rmfr(tmpDir.path);
    }
});

test('$objectExists returns true for cached object', async t => {
    const testGit = new git.Git({ gitDir: '/dev/null' });

    testGit.$knowObject('abc123');
    const result = await testGit.$objectExists('abc123');
    t.true(result);
});
