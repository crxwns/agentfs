/**
 * Adapter that wraps @tursodatabase/serverless Connection to match
 * the DatabasePromise interface used by AgentFS internals.
 *
 * The core challenge: DatabasePromise.prepare() is synchronous and returns
 * a Statement immediately, but serverless Connection.prepare() is async
 * (it needs to fetch column metadata over HTTP).
 *
 * Solution: return a LazyStatement that defers the actual prepare() call
 * until run()/get()/all() is called — those are already async, so the
 * deferral is invisible to callers.
 */

interface ServerlessConnection {
  prepare(sql: string): Promise<ServerlessStatement>;
  execute(sql: string, args?: any[]): Promise<any>;
  exec(sql: string): Promise<any>;
  batch(statements: string[], mode?: string): Promise<any>;
  transaction(fn: (...args: any[]) => any): any;
  close(): Promise<void>;
}

interface ServerlessStatement {
  run(...args: any[]): Promise<any>;
  get(...args: any[]): Promise<any>;
  all(...args: any[]): Promise<any[]>;
  raw(raw?: boolean): ServerlessStatement;
  pluck(pluck?: boolean): ServerlessStatement;
  safeIntegers(toggle?: boolean): ServerlessStatement;
  columns(): any[];
  iterate(...args: any[]): AsyncGenerator<any>;
}

/**
 * A statement that defers the async prepare() call until execution.
 *
 * DatabasePromise.prepare() must return synchronously, but the serverless
 * driver's prepare() is async. LazyStatement bridges this by storing the
 * SQL and only calling conn.prepare() when run/get/all is invoked.
 */
class LazyStatement {
  private conn: ServerlessConnection;
  private sql: string;
  private stmtPromise: Promise<ServerlessStatement> | null = null;
  private _raw = false;

  constructor(conn: ServerlessConnection, sql: string) {
    this.conn = conn;
    this.sql = sql;
  }

  private getStmt(): Promise<ServerlessStatement> {
    if (!this.stmtPromise) {
      this.stmtPromise = this.conn.prepare(this.sql).then((stmt) => {
        if (this._raw) stmt.raw(true);
        return stmt;
      });
    }
    return this.stmtPromise;
  }

  raw(raw?: boolean): this {
    this._raw = raw !== false;
    return this;
  }

  pluck(_pluck?: boolean): this {
    // Not commonly used by AgentFS internals
    return this;
  }

  safeIntegers(_toggle?: boolean): this {
    return this;
  }

  columns(): any[] {
    throw new Error("columns() is not supported synchronously on serverless adapter");
  }

  get source(): void {
    return undefined;
  }

  get reader(): void {
    return undefined;
  }

  get database(): any {
    return undefined;
  }

  async run(...args: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const stmt = await this.getStmt();
    return stmt.run(args);
  }

  async get(...args: any[]): Promise<any> {
    const stmt = await this.getStmt();
    return stmt.get(args);
  }

  async all(...args: any[]): Promise<any[]> {
    const stmt = await this.getStmt();
    return stmt.all(args);
  }

  async *iterate(...args: any[]): AsyncGenerator<any> {
    const stmt = await this.getStmt();
    yield* stmt.iterate(args);
  }

  bind(..._args: any[]): this {
    return this;
  }

  interrupt(): void {}

  close(): void {}
}

/**
 * Wraps a @tursodatabase/serverless Connection to match
 * the DatabasePromise interface expected by AgentFS.openWith().
 *
 * @example
 * ```typescript
 * import { connect } from "@tursodatabase/serverless";
 * import { AgentFS } from "agentfs-sdk";
 * import { createServerlessAdapter } from "agentfs-sdk/serverless";
 *
 * const conn = connect({
 *   url: "http://localhost:8080",
 * });
 *
 * const db = createServerlessAdapter(conn);
 * const agent = await AgentFS.openWith(db);
 * ```
 */
export function createServerlessAdapter(conn: ServerlessConnection): any {
  return {
    name: "serverless",
    readonly: false,
    open: true,
    memory: false,
    inTransaction: false,

    connect(): Promise<void> {
      // serverless connections are lazy — no explicit connect needed
      return Promise.resolve();
    },

    prepare(sql: string): LazyStatement {
      return new LazyStatement(conn, sql);
    },

    transaction(fn: (...args: any[]) => any) {
      return conn.transaction(fn);
    },

    async exec(sql: string): Promise<void> {
      await conn.exec(sql);
    },

    pragma(_source: any, _options: any): Promise<any[]> {
      return Promise.resolve([]);
    },

    backup() {},
    serialize() {},
    function() {},
    aggregate() {},
    table() {},
    loadExtension() {},
    maxWriteReplicationIndex() {},
    interrupt() {},

    defaultSafeIntegers(_toggle?: boolean) {},

    async close(): Promise<void> {
      await conn.close();
    },
  };
}
