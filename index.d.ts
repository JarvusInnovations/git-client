declare module 'git-client' {
  export interface GitOptions {
    command?: string;
    gitDir?: string;
    workTree?: string;
    indexFile?: string;
  }

  export interface ExecOptions {
    /** Set custom git directory */
    $gitDir?: string;
    /** Set custom working tree */
    $workTree?: string;
    /** Set custom index file */
    $indexFile?: string;
    /** Enable spawn mode */
    $spawn?: boolean;
    /** Enable shell mode */
    $shell?: boolean;
    /** Return null instead of throwing on error */
    $nullOnError?: boolean;
    /** Callback for stdout in spawn mode */
    $onStdout?: (line: string) => void;
    /** Callback for stderr in spawn mode */
    $onStderr?: (line: string) => void;
    /** Enable passthrough mode */
    $passthrough?: boolean;
    /** Wait for process to complete */
    $wait?: boolean;
    /** Preserve environment variables */
    $preserveEnv?: boolean;
    /** Custom working directory */
    $cwd?: string;
    /** Custom environment variables */
    $env?: Record<string, string>;
    /** Additional options */
    $options?: Record<string, any>;
    /** Any git command options */
    [key: string]: any;
  }

  export interface SpawnedProcess extends NodeJS.EventEmitter {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    captureOutput(input?: string | null): Promise<string>;
    captureOutputTrimmed(input?: string | null): Promise<string>;
  }

  export interface TreeChild {
    mode: string;
    type: string;
    hash: string;
    name: string;
  }

  export class Git {
    constructor(options?: GitOptions);

    command: string;
    gitDir: string | null;
    workTree: string | null;
    indexFile: string | null;
    version: string | null;

    static getGitDirFromEnvironment(): Promise<string>;
    static getWorkTreeFromEnvironment(): Promise<string | null>;

    getGitDir(): Promise<string>;
    getWorkTree(): Promise<string | null>;
    getIndexPath(): Promise<string>;
    getVersion(): Promise<string | null>;
    satisfiesVersion(range: string): Promise<boolean>;
    requireVersion(range: string): Promise<this>;

    readConfigSet(configPath: string): Promise<Set<string>>;
    writeConfigSet(configPath: string, set: Set<string>): Promise<void>;
    addToConfigSet(configPath: string, ...items: string[]): Promise<Set<string>>;
    removeFromConfigSet(configPath: string, ...items: string[]): Promise<Set<string>>;

    isHash(hash: string): boolean;
    getTreeHash(ref: string, options?: { verify?: boolean }): Promise<string>;
    hashObjectInternally(content: string | Buffer, options?: { type?: string; write?: boolean }): Promise<string>;
    mktreeBatch(children: TreeChild[]): Promise<string>;
    cleanup(): void;

    exec(command: string, ...args: Array<string | ExecOptions>): Promise<string | SpawnedProcess>;

    // Git commands as methods
    add(options?: ExecOptions, ...files: string[]): Promise<string>;
    commit(options?: ExecOptions, message?: string): Promise<string>;
    push(options?: ExecOptions): Promise<string>;
    pull(options?: ExecOptions): Promise<string>;
    checkout(options?: ExecOptions, ref?: string): Promise<string>;
    branch(options?: ExecOptions): Promise<string>;
    merge(options?: ExecOptions, ref?: string): Promise<string>;
    log(options?: ExecOptions): Promise<string>;
    status(options?: ExecOptions): Promise<string>;
    fetch(options?: ExecOptions): Promise<string>;
    remote(options?: ExecOptions): Promise<string>;
    reset(options?: ExecOptions): Promise<string>;
    revert(options?: ExecOptions): Promise<string>;
    tag(options?: ExecOptions): Promise<string>;
    init(options?: ExecOptions): Promise<string>;
    clone(options?: ExecOptions): Promise<string>;
    diff(options?: ExecOptions): Promise<string>;
    show(options?: ExecOptions): Promise<string>;
    stash(options?: ExecOptions): Promise<string>;
    revParse(options?: ExecOptions, ref?: string): Promise<string>;
    [key: string]: any;
  }

  const git: Git & ((command: string, ...args: Array<string | ExecOptions>) => Promise<string | SpawnedProcess>);
  export default git;
}
