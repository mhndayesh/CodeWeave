import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";
import { ExpressBridge } from "../src/contracts/express.js";
import { FastifyBridge } from "../src/contracts/fastify.js";
import { NextBridge } from "../src/contracts/next.js";
import { EventsBridge } from "../src/contracts/events.js";
import { DrizzleBridge } from "../src/contracts/drizzle.js";
import { GenericBridge } from "../src/contracts/generic.js";
import { PrismaBridge } from "../src/contracts/prisma.js";
import { SqlBridge } from "../src/contracts/sql.js";
import { OpenApiBridge } from "../src/contracts/openapi.js";
import { GraphqlBridge } from "../src/contracts/graphql.js";
import { EnvBridge } from "../src/contracts/env.js";
import { runContractBridges, runContractFullScans } from "../src/contracts/index.js";
import { stableId, versionHash } from "../src/hash.js";
import ts from "typescript";

const TEST_ROOT = path.resolve("test/tmp-phase3");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function createRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function makeStore(root: string): GraphStore {
  const dbPath = path.join(root, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

function makeSource(text: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", text, ts.ScriptTarget.Latest, true);
}

beforeEach(() => clean());
afterEach(() => clean());

// ─── ExpressBridge ───────────────────────────────────────────

describe("ExpressBridge", () => {
  it("detects app.get/post/put/patch/delete routes", () => {
    const root = createRepo("exp-01", {});
    const store = makeStore(root);
    const bridge = new ExpressBridge();
    const source = makeSource(`
      app.get('/health', handler);
      app.post('/users', createUser);
      app.put('/users/:id', updateUser);
      app.patch('/users/:id', patchUser);
      app.delete('/users/:id', deleteUser);
    `);
    const fileNodeId = stableId(root, "ts", "file:src/routes.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/routes.ts", qualifiedName: "file:src/routes.ts",
      filePath: "src/routes.ts", startLine: 1, endLine: 1, language: "ts",
    });
    const result = bridge.extract(store, "src/routes.ts", "", source, fileNodeId, root);
    expect(result.routes.length).toBe(5);
    const methods = result.routes.map((r) => r.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
    expect(methods).toContain("PATCH");
    expect(methods).toContain("PUT");

    const routeNodes = store.findNodes("GET /health", 5);
    expect(routeNodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects router.use() with path", () => {
    const root = createRepo("exp-02", {});
    const store = makeStore(root);
    const bridge = new ExpressBridge();
    const source = makeSource(`
      router.use('/api', apiRouter);
      app.use((err, req, res, next) => {});
    `);
    const fileNodeId = stableId(root, "ts", "file:src/app.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/app.ts", qualifiedName: "file:src/app.ts",
      filePath: "src/app.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/app.ts", "", source, fileNodeId, root);
    const routes = store.findNodes("USE /api", 5);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("handles middleware arrays in route definitions", () => {
    const root = createRepo("exp-03", {});
    const store = makeStore(root);
    const bridge = new ExpressBridge();
    const source = makeSource(
      `router.get('/admin', [auth, admin], handler);`,
    );
    const fileNodeId = stableId(root, "ts", "file:src/admin.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/admin.ts", qualifiedName: "file:src/admin.ts",
      filePath: "src/admin.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/admin.ts", "", source, fileNodeId, root);
    const routes = store.findNodes("GET /admin", 5);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── FastifyBridge ───────────────────────────────────────────

describe("FastifyBridge", () => {
  it("detects fastify.get/post routes with schema options", () => {
    const root = createRepo("fas-01", {});
    const store = makeStore(root);
    const bridge = new FastifyBridge();
    const source = makeSource(`
      fastify.get('/health', { schema: { response: { 200: { type: 'object' } } } }, handler);
      fastify.post('/users', createUser);
    `);
    const fileNodeId = stableId(root, "ts", "file:src/app.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/app.ts", qualifiedName: "file:src/app.ts",
      filePath: "src/app.ts", startLine: 1, endLine: 1, language: "ts",
    });
    const result = bridge.extract(store, "src/app.ts", "", source, fileNodeId, root);
    expect(result.routes.length).toBe(2);

    const healthRoutes = store.findNodes("GET /health", 5);
    expect(healthRoutes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── NextBridge ──────────────────────────────────────────────

describe("NextBridge", () => {
  it("detects App Router routes from file path", () => {
    const root = createRepo("next-01", {});
    const store = makeStore(root);
    const bridge = new NextBridge();
    const source = makeSource(`
      export async function GET(req) { return Response.json({}); }
      export async function POST(req) { return Response.json({}); }
    `);
    const fileNodeId = stableId(root, "ts", "file:src/app/api/users/route.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/app/api/users/route.ts",
      qualifiedName: "file:src/app/api/users/route.ts",
      filePath: "src/app/api/users/route.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/app/api/users/route.ts", "", source, fileNodeId, root);
    const routes = store.findNodes("api/users", 10);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects page routes via App Router convention", () => {
    const root = createRepo("next-02", {});
    const store = makeStore(root);
    const bridge = new NextBridge();
    const source = makeSource(
      `export default function Page() { return null; }`,
    );
    const fileNodeId = stableId(root, "ts", "file:src/app/dashboard/page.tsx");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/app/dashboard/page.tsx",
      qualifiedName: "file:src/app/dashboard/page.tsx",
      filePath: "src/app/dashboard/page.tsx", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/app/dashboard/page.tsx", "", source, fileNodeId, root);
    const routes = store.findNodes("dashboard", 10);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── EventsBridge ────────────────────────────────────────────

describe("EventsBridge", () => {
  it("detects emit/publish/send events", () => {
    const root = createRepo("evt-01", {});
    const store = makeStore(root);
    const bridge = new EventsBridge();
    const source = makeSource(`
      emit('user.created', { id: 1 });
      EventBus.publish('order.placed', order);
      eventEmitter.emit('notification.sent', notif);
    `);
    const fileNodeId = stableId(root, "ts", "file:src/events.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/events.ts", qualifiedName: "file:src/events.ts",
      filePath: "src/events.ts", startLine: 1, endLine: 1, language: "ts",
    });
    const result = bridge.extract(store, "src/events.ts", "", source, fileNodeId, root);
    expect(result.events.length).toBeGreaterThanOrEqual(3);
    const names = result.events.map((e) => e.eventName);
    expect(names).toContain("user.created");
    expect(names).toContain("order.placed");
    expect(names).toContain("notification.sent");

    const eventNodes = store.findNodes("user.created", 5);
    expect(eventNodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects subscribe/on/consume event listeners", () => {
    const root = createRepo("evt-02", {});
    const store = makeStore(root);
    const bridge = new EventsBridge();
    const source = makeSource(`
      EventBus.on('user.created', handleUserCreated);
      queue.subscribe('order.placed', processOrder);
      eventEmitter.on('notification.sent', sendPush);
    `);
    const fileNodeId = stableId(root, "ts", "file:src/listeners.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/listeners.ts", qualifiedName: "file:src/listeners.ts",
      filePath: "src/listeners.ts", startLine: 1, endLine: 1, language: "ts",
    });
    const result = bridge.extract(store, "src/listeners.ts", "", source, fileNodeId, root);
    const consumeEvents = result.events.filter((e) => e.direction === "consumes");
    expect(consumeEvents.length).toBeGreaterThanOrEqual(3);
    store.close();
  });
});

// ─── DrizzleBridge ───────────────────────────────────────────

describe("DrizzleBridge", () => {
  it("detects pgTable schema definitions", () => {
    const root = createRepo("dz-01", {});
    const store = makeStore(root);
    const bridge = new DrizzleBridge();
    const source = makeSource(`
      export const users = pgTable('users', {
        id: serial('id').primaryKey(),
        name: text('name').notNull(),
      });
    `);
    const fileNodeId = stableId(root, "ts", "file:src/db/schema.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/db/schema.ts", qualifiedName: "file:src/db/schema.ts",
      filePath: "src/db/schema.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/db/schema.ts", "", source, fileNodeId, root);
    const tables = store.findNodes("users", 5);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects drizzle read/write patterns via pgTable definitions", () => {
    const root = createRepo("dz-02", {});
    const store = makeStore(root);
    const bridge = new DrizzleBridge();
    const srcText = `
      export const users = pgTable('users', {
        id: serial('id').primaryKey(),
        name: text('name').notNull(),
      });
      const result = db().select().from(users).where(eq(users.id, 1));
    `;
    const source = makeSource(srcText);
    const fileNodeId = stableId(root, "ts", "file:src/db/queries.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/db/queries.ts", qualifiedName: "file:src/db/queries.ts",
      filePath: "src/db/queries.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/db/queries.ts", srcText, source, fileNodeId, root);
    const tables = store.findNodes("users", 5);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── GenericBridge ───────────────────────────────────────────

describe("GenericBridge", () => {
  it("detects fetch() calls as CONSUMES_ROUTE", () => {
    const root = createRepo("gen-01", {});
    const store = makeStore(root);
    const bridge = new GenericBridge();
    const source = makeSource(`fetch('/api/data', { method: 'GET' });`);
    const fileNodeId = stableId(root, "ts", "file:src/client.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/client.ts", qualifiedName: "file:src/client.ts",
      filePath: "src/client.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/client.ts", "fetch('/api/data', { method: 'GET' });", source, fileNodeId, root);
    const consumers = store.outgoing(fileNodeId, ["CONSUMES_ROUTE"]);
    expect(consumers.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects db.write/create/update patterns", () => {
    const root = createRepo("gen-02", {});
    const store = makeStore(root);
    const bridge = new GenericBridge();
    const srcText = `
      const users = db.findMany('users', {});
      await prisma.create('orders', {});
    `;
    const source = makeSource(srcText);
    const fileNodeId = stableId(root, "ts", "file:src/data.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/data.ts", qualifiedName: "file:src/data.ts",
      filePath: "src/data.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/data.ts", srcText, source, fileNodeId, root);
    const reads = store.outgoing(fileNodeId, ["READS_TABLE"]);
    const writes = store.outgoing(fileNodeId, ["WRITES_TABLE"]);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── PrismaBridge ────────────────────────────────────────────

describe("PrismaBridge", () => {
  it("parses prisma schema models", () => {
    const root = createRepo("pr-01", {
      "prisma/schema.prisma": `
        model User {
          id        Int      @id @default(autoincrement())
          email     String   @unique
          name      String?
          posts     Post[]
        }

        model Post {
          id        Int      @id @default(autoincrement())
          title     String
          author    User     @relation(fields: [authorId], references: [id])
          authorId  Int
        }
      `,
    });
    const store = makeStore(root);
    const bridge = new PrismaBridge();
    const schemas = bridge.extractAll(store, root);
    expect(schemas.length).toBe(2);
    const modelNames = schemas.map((s) => s.name);
    expect(modelNames).toContain("User");
    expect(modelNames).toContain("Post");

    const userTable = store.findNodes("User", 5);
    expect(userTable.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── SqlBridge ───────────────────────────────────────────────

describe("SqlBridge", () => {
  it("parses CREATE TABLE migrations", () => {
    const root = createRepo("sql-01", {
      "migrations/001_init.sql": `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          name TEXT
        );
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          total REAL DEFAULT 0.0,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `,
    });
    const store = makeStore(root);
    const bridge = new SqlBridge();
    const tables = bridge.extractAll(store, root);
    expect(tables.length).toBe(2);
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("orders");
    const usersTable = tables.find((t) => t.name === "users")!;
    expect(usersTable.columns.length).toBeGreaterThanOrEqual(3);

    const userTable = store.findNodes("users", 5);
    expect(userTable.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── OpenApiBridge ───────────────────────────────────────────

describe("OpenApiBridge", () => {
  it("parses OpenAPI JSON spec endpoints", () => {
    const root = createRepo("oas-01", {
      "api/openapi.json": JSON.stringify({
        openapi: "3.0.0",
        info: { title: "My API", version: "1.0" },
        paths: {
          "/users": { get: { summary: "List users" }, post: { summary: "Create user" } },
          "/users/{id}": { get: { summary: "Get user" }, delete: { summary: "Delete user" } },
        },
      }),
    });
    const store = makeStore(root);
    const bridge = new OpenApiBridge();
    const result = bridge.extractAll(store, root);
    expect(result.routes.length).toBe(4);
    expect(result.apis.length).toBe(4);

    const routeNodes = store.findNodes("/users", 10);
    expect(routeNodes.length).toBeGreaterThanOrEqual(2);
    store.close();
  });
});

// ─── GraphqlBridge ───────────────────────────────────────────

describe("GraphqlBridge", () => {
  it("parses .graphql schema types and fields", () => {
    const root = createRepo("gql-01", {
      "schema/schema.graphql": `
        type User {
          id: ID!
          name: String!
          email: String!
          posts: [Post!]!
        }

        type Post {
          id: ID!
          title: String!
          author: User!
        }

        input CreateUserInput {
          name: String!
          email: String!
        }

        enum Role {
          ADMIN
          USER
        }
      `,
    });
    const store = makeStore(root);
    const bridge = new GraphqlBridge();
    const models = bridge.extractAll(store, root);
    expect(models.length).toBe(4);

    const typeNames = models.map((m) => m.name);
    expect(typeNames).toContain("User");
    expect(typeNames).toContain("Post");
    expect(typeNames).toContain("CreateUserInput");
    expect(typeNames).toContain("Role");

    const userTable = store.findNodes("User", 5);
    expect(userTable.length).toBeGreaterThanOrEqual(1);

    const edges = store.outgoing(userTable[0].identity.stableId, ["CONTAINS"]);
    expect(edges.length).toBeGreaterThanOrEqual(4);

    store.close();
  });
});

// ─── EnvBridge ───────────────────────────────────────────────

describe("EnvBridge", () => {
  it("detects process.env.XXX usage", () => {
    const root = createRepo("env-01", {});
    const store = makeStore(root);
    const bridge = new EnvBridge();
    const srcText = `
      const dbUrl = process.env.DATABASE_URL;
      const apiKey = process.env.API_KEY;
      if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
    `;
    const source = makeSource(srcText);
    const fileNodeId = stableId(root, "ts", "file:src/config.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/config.ts", qualifiedName: "file:src/config.ts",
      filePath: "src/config.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/config.ts", srcText, source, fileNodeId, root);

    const envNodes = store.findNodes("DATABASE_URL", 5);
    expect(envNodes.length).toBeGreaterThanOrEqual(1);
    const edges = store.outgoing(fileNodeId, ["REFERENCES"]);
    const envEdge = edges.find((e) => {
      const node = store.getNode(e.targetId);
      return node?.name === "DATABASE_URL";
    });
    expect(envEdge).toBeDefined();
    expect(envEdge?.kind).toBe("REFERENCES");
    store.close();
  });

  it("detects env() and config() calls", () => {
    const root = createRepo("env-02", {});
    const store = makeStore(root);
    const bridge = new EnvBridge();
    const srcText = `
      const port = env('PORT', '3000');
      const dbUrl = config('database.url');
    `;
    const source = makeSource(srcText);
    const fileNodeId = stableId(root, "ts", "file:src/env.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/env.ts", qualifiedName: "file:src/env.ts",
      filePath: "src/env.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/env.ts", srcText, source, fileNodeId, root);

    const portNodes = store.findNodes("PORT", 5);
    expect(portNodes.length).toBeGreaterThanOrEqual(1);
    const dbUrlNodes = store.findNodes("database.url", 5);
    expect(dbUrlNodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects process.env['XXX'] bracket access", () => {
    const root = createRepo("env-03", {});
    const store = makeStore(root);
    const bridge = new EnvBridge();
    const srcText = `
      const secret = process.env['SECRET_KEY'];
    `;
    const source = makeSource(srcText);
    const fileNodeId = stableId(root, "ts", "file:src/secrets.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/secrets.ts", qualifiedName: "file:src/secrets.ts",
      filePath: "src/secrets.ts", startLine: 1, endLine: 1, language: "ts",
    });
    bridge.extract(store, "src/secrets.ts", srcText, source, fileNodeId, root);
    const secretNodes = store.findNodes("SECRET_KEY", 5);
    expect(secretNodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── Contract Registry Integration ───────────────────────────

describe("Contract registry integration", () => {
  it("runContractBridges dispatches to correct bridges", () => {
    const root = createRepo("reg-01", {
      "src/routes.ts": `
        import { Router } from 'express';
        const router = Router();
        router.get('/health', (req, res) => res.json({ ok: true }));
        router.post('/users', createUser);
      `,
    });
    const store = makeStore(root);
    const fileNodeId = stableId(root, "ts", "file:src/routes.ts");
    store.upsertNode({
      identity: { stableId: fileNodeId, versionHash: "v1" },
      kind: "file", name: "src/routes.ts", qualifiedName: "file:src/routes.ts",
      filePath: "src/routes.ts", startLine: 1, endLine: 1, language: "ts",
    });
    const text = fs.readFileSync(path.join(root, "src/routes.ts"), "utf8");
    const source = makeSource(text);
    runContractBridges(store, "src/routes.ts", text, source, fileNodeId, root);
    const routes = store.findNodes("/health", 10);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("full index with contract bridges produces contract edges", async () => {
    const root = createRepo("reg-02", {
      "src/app.ts": `
        import { Router } from 'express';
        const router = Router();
        router.get('/api/status', (req, res) => res.json({}));
      `,
      "src/events.ts": `emit('test.event', { data: 1 });`,
      "src/data.ts": `const x = db.findMany('items', {});`,
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    const allEdges = store.incoming(
      stableId(root, "ts", "route:GET /api/status"),
      ["EXPOSES_ROUTE"],
    );
    expect(allEdges.length).toBeGreaterThanOrEqual(1);

    const eventNodes = store.findNodes("test.event", 5);
    expect(eventNodes.length).toBeGreaterThanOrEqual(1);

    store.close();
  });
});
