# git-client

[![Tests](https://github.com/JarvusInnovations/git-client/actions/workflows/test.yml/badge.svg)](https://github.com/JarvusInnovations/git-client/actions/workflows/test.yml)
[![npm version](https://badge.fury.io/js/git-client.svg)](https://badge.fury.io/js/git-client)

A lightweight, Promise-based Git client for Node.js that executes the git binary. This library provides a clean, Promise-based interface to Git operations while maintaining the full power and flexibility of the git command line.

## Features

- Promise-based API for all Git operations
- Supports all Git commands with automatic method generation
- Flexible option handling with both short and long format support
- Spawn mode for streaming operations
- Built-in support for common Git operations
- Minimal dependencies
- Full TypeScript support with type definitions

## Requirements

- Node.js 16.x or higher
- Git installed and available in PATH

## Installation

```bash
npm install git-client
```

## Basic Usage

### Simple Command Execution

```js
const git = require('git-client');

// Get current commit hash
const hash = await git('rev-parse', 'HEAD');
```

### Using Named Methods

```js
const git = require('git-client');

// Using the revParse method
const hash = await git.revParse({ verify: true }, 'HEAD');

// Using the status method
const status = await git.status({ porcelain: true });
```

### Working with Options

```js
// Short format options
const log = await git('log', { n: 5 });

// Long format options
const diff = await git('diff', { 'word-diff': true });

// Mixed options with arguments
const show = await git('show', { format: '%H', 'no-patch': true }, 'HEAD');
```

## Advanced Usage

### Spawning Processes

Use spawn mode for operations that need streaming or real-time output:

```js
// Save file from the web
const writer = await git.hashObject({ w: true, stdin: true, $spawn: true });
const response = await axios.get('https://placekitten.com/1000/1000', { responseType: 'stream' });

// pipe data from HTTP response into git
response.data.pipe(writer.stdin);

// wait for data to finish
await new Promise((resolve, reject) => {
    response.data.on('end', () => resolve());
    response.data.on('error', () => reject());
});

// read written hash
const hash = await writer.captureOutputTrimmed();
```

### Building Trees

```js
const lines = [
    '100644 blob bc0c330151d9a2ca8d87d1ff914b87f152036b19\tkitten.jpg',
    '100644 blob 97ab63ad46e50ac4012ac9370b33878b224c4fa3\tcage.jpg'
];

const mktree = await git.mktree({ $spawn: true });
const hash = await mktree.captureOutputTrimmed(lines.join('\n')+'\n');
```

### Custom Git Directory

```js
const customGit = new git.Git({ gitDir: '/path/to/repo/.git' });
const status = await customGit.status();
```

## TypeScript Support

The library includes TypeScript definitions for all methods and options. When using TypeScript, you'll get full type checking and autocompletion for:

- Git instance configuration options
- Command execution options
- All git commands and their parameters
- Spawn mode process types
- Event handlers and callbacks

## API Reference

### Main Function

The default export is a function that executes git commands:

```js
git(command: string, ...args: Array<string|object>): Promise<string>
```

### Special Options

When passing options objects, the following special keys are supported:

- `$gitDir`: Set custom git directory
- `$workTree`: Set custom working tree
- `$indexFile`: Set custom index file
- `$spawn`: Enable spawn mode
- `$shell`: Enable shell mode
- `$nullOnError`: Return null instead of throwing on error
- `$onStdout`: Callback for stdout in spawn mode
- `$onStderr`: Callback for stderr in spawn mode

### Common Methods

All git commands are available as methods. Some commonly used ones include:

- `git.status(options)`
- `git.add(options, ...files)`
- `git.commit(options, message)`
- `git.push(options)`
- `git.pull(options)`
- `git.checkout(options, ref)`
- `git.branch(options)`
- `git.merge(options, ref)`
- `git.log(options)`

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -am 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Running Tests

```bash
npm test
```

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

Created and maintained by [Jarvus Innovations](https://github.com/JarvusInnovations).
