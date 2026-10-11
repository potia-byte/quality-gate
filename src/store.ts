import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LEDGER_DIRECTORY } from "./git.js";
import { type GateState, initialState } from "./types.js";

/**
 * Transactional access to the ledger. `update` runs `mutate` against a copy
 * and commits it only if `mutate` returns normally; a throw discards every
 * change made inside it.
 */
export interface GateStore {
  read(): Promise<GateState>;
  update<T>(mutate: (state: GateState) => T | Promise<T>): Promise<T>;
}

const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Windows briefly denies rename/unlink while antivirus or an indexer holds a
 * handle on a freshly written file. Retrying with a short backoff is the
 * standard remedy; other error codes are rethrown immediately.
 */
export async function withFsRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 25;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code !== "string" || !TRANSIENT_FS_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

abstract class SerializedStore implements GateStore {
  private tail: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<GateState>;
  protected abstract save(state: GateState): Promise<void>;

  read(): Promise<GateState> {
    return this.enqueue(async () => structuredClone(await this.load()));
  }

  update<T>(mutate: (state: GateState) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const working = structuredClone(await this.load());
      const result = await mutate(working);
      working.updated_at = new Date().toISOString();
      await this.save(working);
      return result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/** In-process ledger; nothing is persisted. */
export class MemoryStore extends SerializedStore {
  private state: GateState;

  constructor(state: GateState = initialState()) {
    super();
    this.state = structuredClone(state);
  }

  protected async load(): Promise<GateState> {
    return this.state;
  }

  protected async save(state: GateState): Promise<void> {
    this.state = state;
  }
}

/**
 * JSON-file ledger. Writes go to a temporary file and are renamed into place,
 * so a crash never leaves a half-written ledger. Safe within one process;
 * there is no cross-process lock (see README, limitations).
 */
export class FileStore extends SerializedStore {
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
  }

  /** `<root>/.quality-gate/state.json`, the location the git helpers ignore. */
  static forRepository(root: string): FileStore {
    return new FileStore(join(root, LEDGER_DIRECTORY, "state.json"));
  }

  protected async load(): Promise<GateState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<GateState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error(`Unrecognized ledger format: ${this.path}`);
      }
      return { ...initialState(), ...parsed } as GateState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return initialState();
      }
      throw error;
    }
  }

  protected async save(state: GateState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      await withFsRetry(() => rename(temporary, this.path));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
