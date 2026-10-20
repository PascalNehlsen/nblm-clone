// startDemoCore (apps/web/lib/auth/demo.ts) is the pure core of the demo login:
// it decides where an anonymous user goes after sign-in. Spec: .git/F2-SPEC.md.
// The error text from the database must never reach the redirect URL and nothing
// is logged.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_NOTEBOOK_TITLE,
  startDemoCore,
  type DemoDeps,
} from "../../../apps/web/lib/auth/demo";

const NOTEBOOK_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-2222-4333-8444-555555555555";

function makeDeps(overrides: Partial<DemoDeps> = {}) {
  const deps = {
    getUser: vi.fn(async () => ({ id: "u1", isAnonymous: true }) as { id: string; isAnonymous: boolean } | null),
    firstNotebookId: vi.fn(async () => null as string | null),
    createNotebook: vi.fn<(title: string) => Promise<{ id: string } | { error: string }>>(async () => ({ id: NOTEBOOK_ID })),
    ...overrides,
  };
  return deps;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startDemoCore: who may start", () => {
  it("exports the demo notebook title", () => {
    expect(DEMO_NOTEBOOK_TITLE).toBe("Demo: Beispielquellen");
  });

  it("no user goes to /login and touches nothing else", async () => {
    const deps = makeDeps({ getUser: vi.fn(async () => null) });
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/login" });
    expect(deps.firstNotebookId).not.toHaveBeenCalled();
    expect(deps.createNotebook).not.toHaveBeenCalled();
  });

  it("a non-anonymous user goes to / and no notebook is created", async () => {
    const deps = makeDeps({ getUser: vi.fn(async () => ({ id: "u2", isAnonymous: false })) });
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/" });
    expect(deps.firstNotebookId).not.toHaveBeenCalled();
    expect(deps.createNotebook).not.toHaveBeenCalled();
  });
});

describe("startDemoCore: notebook lookup and creation", () => {
  it("an existing notebook is reused and nothing is created", async () => {
    const deps = makeDeps({ firstNotebookId: vi.fn(async () => OTHER_ID) });
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/" });
    expect(deps.createNotebook).not.toHaveBeenCalled();
  });

  it("without a notebook it creates one with the demo title and goes to the list", async () => {
    const deps = makeDeps();
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/" });
    expect(deps.createNotebook).toHaveBeenCalledTimes(1);
    expect(deps.createNotebook).toHaveBeenCalledWith("Demo: Beispielquellen");
  });

  it("demo_notebook_exists goes to the list", async () => {
    const firstNotebookId = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null);
    const deps = makeDeps({
      firstNotebookId,
      createNotebook: vi.fn(async () => ({ error: "demo_notebook_exists" })),
    });
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/" });
    expect(firstNotebookId).toHaveBeenCalledTimes(1);
  });

  it("demo_notebook_exists inside a longer Postgres message is still recognised", async () => {
    const firstNotebookId = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null);
    const deps = makeDeps({
      firstNotebookId,
      createNotebook: vi.fn(async () => ({ error: "P0001: demo_notebook_exists (context)" })),
    });
    await expect(startDemoCore(deps)).resolves.toEqual({ redirect: "/" });
    expect(firstNotebookId).toHaveBeenCalledTimes(1);
  });
});

describe("startDemoCore: errors map to fixed codes", () => {
  const cases: [string, string][] = [
    ["demo_unavailable", "/login?fehler=demo_nicht_verfuegbar"],
    ["demo_capacity", "/login?fehler=demo_voll"],
    ["fehler", "/login?fehler=anmeldung"],
    ["permission denied for table notebooks", "/login?fehler=anmeldung"],
    ["", "/login?fehler=anmeldung"],
  ];

  for (const [error, redirect] of cases) {
    it(`error ${JSON.stringify(error)} redirects to ${redirect}`, async () => {
      const deps = makeDeps({ createNotebook: vi.fn(async () => ({ error })) });
      await expect(startDemoCore(deps)).resolves.toEqual({ redirect });
    });
  }

  it("the database error text never reaches the redirect", async () => {
    const marker = "SECRET-DB-DETAIL relation private.demo_template 42";
    for (const error of [marker, `demo_capacity ${marker}`, `demo_unavailable ${marker}`]) {
      const deps = makeDeps({ createNotebook: vi.fn(async () => ({ error })) });
      const outcome = await startDemoCore(deps);
      expect(outcome.redirect).not.toContain("SECRET");
      expect(outcome.redirect).not.toContain(encodeURIComponent(marker));
      expect(outcome.redirect).not.toContain("demo_template");
      expect(outcome.redirect).toMatch(/^\/login\?fehler=[a-z_]+$/);
    }
  });

  it("never logs", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
    await startDemoCore(makeDeps({ createNotebook: vi.fn(async () => ({ error: "boom" })) }));
    await startDemoCore(makeDeps({ createNotebook: vi.fn(async () => ({ error: "demo_capacity" })) }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
