import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { PythonIndexer } from "../src/languages/python.js";
import { RustIndexer } from "../src/languages/rust.js";
import { GoIndexer } from "../src/languages/go.js";
import { indexFileWithLanguage, getRegisteredLanguages, getIndexerForFile } from "../src/languages/index.js";
import { extractAndStore, makeFileNode } from "../src/languages/base.js";
import { VERIFICATION } from "../src/types.js";

const TEST_ROOT = path.resolve("test/tmp-phase6");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function makeStore(root: string): GraphStore {
  const dbPath = path.join(root, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

beforeEach(() => clean());
afterEach(() => clean());

// ─── PythonIndexer ───────────────────────────────────────────

describe("PythonIndexer", () => {
  it("extracts functions, classes, and imports", () => {
    const root = path.join(TEST_ROOT, "py-01");
    fs.mkdirSync(root, { recursive: true });
    const store = makeStore(root);
    const indexer = new PythonIndexer();
    const text = `
import os, sys
from datetime import datetime
from .models import User

def login(email, password):
    pass

class AuthService:
    def validate(self):
        pass
`;
    const result = indexer.extract(text, "src/auth.py", root);
    expect(result.nodes.length).toBeGreaterThanOrEqual(3);

    const funcNames = result.nodes.filter((n) => n.kind === "function").map((n) => n.name);
    expect(funcNames).toContain("login");

    const classNames = result.nodes.filter((n) => n.kind === "class").map((n) => n.name);
    expect(classNames).toContain("AuthService");

    const importEdges = result.edges.filter((e) => e.kind === "IMPORTS");
    expect(importEdges.length).toBeGreaterThanOrEqual(2);

    const containsEdges = result.edges.filter((e) => e.kind === "CONTAINS");
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    expect(containsEdges.every((e) => e.verification === VERIFICATION.PATTERN_MATCHED)).toBe(true);

    store.close();
  });

  it("handles async functions", () => {
    const indexer = new PythonIndexer();
    const result = indexer.extract(
      "async def fetch_data(url): pass",
      "src/fetch.py",
      "/repo",
    );
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain("fetch_data");
  });
});

// ─── RustIndexer ─────────────────────────────────────────────

describe("RustIndexer", () => {
  it("extracts functions, structs, enums, traits, impls, and use statements", () => {
    const root = path.join(TEST_ROOT, "rs-01");
    fs.mkdirSync(root, { recursive: true });
    const store = makeStore(root);
    const indexer = new RustIndexer();
    const text = `
use std::collections::HashMap;
use crate::models::User;

pub fn create_user(name: &str) -> User {
    todo!()
}

pub struct Config {
    pub port: u16,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Repository {
    fn save(&self) -> Result<()>;
}

impl Config {
    pub fn new() -> Self {
        Config { port: 8080 }
    }
}
`;
    const result = indexer.extract(text, "src/config.rs", root);
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain("create_user");
    expect(names).toContain("Config");
    expect(names).toContain("Status");
    expect(names).toContain("Repository");
    expect(names).toContain("impl Config");

    const importEdges = result.edges.filter((e) => e.kind === "IMPORTS");
    expect(importEdges.length).toBeGreaterThanOrEqual(2);

    store.close();
  });
});

// ─── GoIndexer ───────────────────────────────────────────────

describe("GoIndexer", () => {
  it("extracts functions, methods, types, and imports", () => {
    const root = path.join(TEST_ROOT, "go-01");
    fs.mkdirSync(root, { recursive: true });
    const store = makeStore(root);
    const indexer = new GoIndexer();
    const text = `
import (
    "fmt"
    "net/http"
    "github.com/gin-gonic/gin"
)

type User struct {
    Name string
}

type AuthService interface {
    Login()
}

func NewUser(name string) *User {
    return &User{Name: name}
}

func (u *User) Greet() string {
    return "Hello"
}
`;
    const result = indexer.extract(text, "src/user.go", root);
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain("User");
    expect(names).toContain("AuthService");
    expect(names).toContain("NewUser");
    expect(names).toContain("Greet");

    const importEdges = result.edges.filter((e) => e.kind === "IMPORTS");
    expect(importEdges.length).toBeGreaterThanOrEqual(3);

    store.close();
  });
});

// ─── Language Registry ───────────────────────────────────────

describe("Language registry", () => {
  it("dispatches to correct indexer by extension", () => {
    expect(getIndexerForFile("main.py")).toBeDefined();
    expect(getIndexerForFile("main.rs")).toBeDefined();
    expect(getIndexerForFile("main.go")).toBeDefined();
    expect(getIndexerForFile("main.ts")).toBeUndefined();
  });

  it("indexFileWithLanguage stores nodes and edges in graph", () => {
    const root = path.join(TEST_ROOT, "reg-01");
    fs.mkdirSync(root, { recursive: true });
    const store = makeStore(root);

    const pyResult = indexFileWithLanguage(
      store,
      "src/app.py",
      "def hello(): pass\nimport os\nclass MyClass: pass",
      root,
    );
    expect(pyResult).toBe(true);

    const tsResult = indexFileWithLanguage(
      store,
      "src/app.ts",
      "export function hello() {}",
      root,
    );
    expect(tsResult).toBe(false);

    expect(store.getStats().nodes).toBeGreaterThanOrEqual(3);

    store.close();
  });

  it("getRegisteredLanguages returns correct names", () => {
    const langs = getRegisteredLanguages();
    expect(langs.some((l) => l.includes("python"))).toBe(true);
    expect(langs.some((l) => l.includes("rust"))).toBe(true);
    expect(langs.some((l) => l.includes("go"))).toBe(true);
  });
});
