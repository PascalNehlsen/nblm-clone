// MemberList renders a compact list of a notebook's members (a name and a role per row) for
// everybody. The owner-only management controls -- the role select, the per-member "Entfernen"
// button and the share form ("Nutzer-ID" field, a role select offering Bearbeiter/Betrachter,
// "Teilen" button) -- live inside a modal dialog that a "Verwalten" button opens. Only a
// non-anonymous owner gets that button and that dialog (AGENTS.md: "an editor cannot change
// roles"; this is the first line of defense, RLS is the second).
//
// Rendered with renderToStaticMarkup, same technique as
// tests/unit/web-shell.test.tsx (calling the component function directly,
// not through a JSX runtime that needs a browser/DOM). The dialog and its children are in the
// static markup even though the dialog is closed, so "inside the dialog" is checked by
// splitting the markup at the <dialog> tags (nested dialogs, e.g. a remove confirmation,
// count as inside).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberList } from "@/app/(app)/notebooks/[id]/member-list";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";

const members = [
  { userId: OWNER_ID, role: "owner" as const },
  { userId: VIEWER_ID, role: "viewer" as const },
];

/** Splits markup into what is outside any <dialog> and what is inside one (balanced, so a
 * nested dialog stays inside). The <dialog> tags themselves are in neither part. */
function splitByDialog(markup: string): { outside: string; inside: string } {
  let depth = 0;
  let outside = "";
  let inside = "";
  let last = 0;
  for (const match of markup.matchAll(/<\/?dialog\b[^>]*>/g)) {
    const segment = markup.slice(last, match.index);
    if (depth === 0) outside += segment;
    else inside += segment;
    depth += match[0].startsWith("</") ? -1 : 1;
    last = match.index + match[0].length;
  }
  outside += markup.slice(last);
  return { outside, inside };
}

/** Visible text of a markup fragment: tags (and therefore attributes such as a hidden input's
 * value="<full-uuid>") removed. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Pulls out each rendered `<option ...>...</option>` segment, so a test can
 * check what a <select> actually offers without being tripped up by
 * "Eigentümer" legitimately appearing elsewhere in the markup as a member's
 * role label (the owner's own row must say "Eigentümer"; it must just never
 * be an offered, selectable role). */
function extractOptionTags(markup: string): string[] {
  return markup.match(/<option\b[^>]*>.*?<\/option>/gs) ?? [];
}

/** Every <li> row whose visible text contains the shortened 8-character id prefix of
 * `userId`. Matched by that prefix, not the full id: a row with no management controls
 * correctly has no hidden form inputs at all, so the full id never appears in its markup --
 * only the shortened prefix every row shows. Assumes a flat list (no nested <li>). */
function rowsFor(markup: string, userId: string): string[] {
  const prefix = userId.slice(0, 8);
  const rows = markup.match(/<li\b[^>]*>.*?<\/li>/gs) ?? [];
  return rows.filter((row) => textOf(row).includes(prefix));
}

describe("MemberList: owner sees a compact list and a Verwalten button", () => {
  const markup = renderToStaticMarkup(MemberList({ members, currentUserId: OWNER_ID, myRole: "owner" }));
  const { outside, inside } = splitByDialog(markup);

  it("renders a dialog, opened by a \"Verwalten\" button that sits outside of it", () => {
    expect(markup).toMatch(/<dialog\b/);
    expect(outside).toMatch(/<button\b[^>]*>\s*Verwalten\s*<\/button>/);
    expect(inside).not.toMatch(/<button\b[^>]*>\s*Verwalten\s*<\/button>/);
  });

  it("shows every member with a name and a role in the compact list outside the dialog: \"Du\" for the own row, a shortened id for the other, a German role label each", () => {
    const text = textOf(outside);
    expect(text).toMatch(/\bDu\b/);
    expect(text).toContain("Eigentümer");
    expect(text).toContain(VIEWER_ID.slice(0, 8));
    expect(text).toContain("Betrachter");
    expect(rowsFor(outside, VIEWER_ID)).toHaveLength(1);
    expect(textOf(rowsFor(outside, VIEWER_ID)[0]!)).toContain("Betrachter");
  });

  it("shows a shortened form of the other member's id, not the full uuid, in the visible text (hidden form fields legitimately carry the full id so the role-change/remove actions have something to submit)", () => {
    const visibleText = textOf(markup);
    expect(visibleText).not.toContain(VIEWER_ID);
    expect(visibleText).toContain(VIEWER_ID.slice(0, 8));
  });

  it("keeps the share form (a \"Nutzer-ID\" field and a \"Teilen\" button) inside the dialog, not in the compact list", () => {
    expect(inside).toMatch(/Nutzer-ID/);
    expect(inside).toMatch(/Teilen/);
    expect(outside).not.toMatch(/Nutzer-ID/);
    expect(outside).not.toMatch(/Teilen/);
  });

  it("offers Bearbeiter (value \"editor\") and Betrachter (value \"viewer\") as roles inside the dialog, never owner as a selectable option, and no select outside it", () => {
    expect(extractOptionTags(outside)).toEqual([]);
    expect(outside).not.toMatch(/<select\b/);

    const options = extractOptionTags(inside);
    expect(options.length).toBeGreaterThan(0);

    const ownerOption = options.find(
      (tag) => tag.includes("Eigentümer") || /value=["']owner["']/.test(tag),
    );
    expect(ownerOption).toBeUndefined();

    const editorOption = options.find((tag) => /value=["']editor["']/.test(tag));
    expect(editorOption).toBeDefined();
    expect(editorOption).toMatch(/Bearbeiter/);

    const viewerOption = options.find((tag) => /value=["']viewer["']/.test(tag));
    expect(viewerOption).toBeDefined();
    expect(viewerOption).toMatch(/Betrachter/);
  });

  it("renders the per-member \"Entfernen\" control and the role-change control inside the dialog only", () => {
    expect(inside).toMatch(/Entfernen/);
    expect(inside).toMatch(/Rolle ändern/);
    expect(outside).not.toMatch(/Entfernen/);
    expect(outside).not.toMatch(/Rolle ändern/);
    expect(outside).not.toMatch(/<form\b/);
  });
});

describe("MemberList: an editor sees the members but no management controls", () => {
  const markup = renderToStaticMarkup(MemberList({ members, currentUserId: VIEWER_ID, myRole: "editor" }));

  it("has no Verwalten button, no dialog, no share form, no \"Teilen\" button and no \"Entfernen\" button", () => {
    expect(markup).not.toMatch(/Verwalten/);
    expect(markup).not.toMatch(/<dialog\b/);
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
    expect(markup).not.toMatch(/Entfernen/);
    expect(markup).not.toMatch(/<select\b/);
  });

  it("still lists every member with a name and a role", () => {
    const text = textOf(markup);
    expect(text).toMatch(/\bDu\b/);
    expect(text).toContain("Eigentümer");
    expect(text).toContain(OWNER_ID.slice(0, 8));
    expect(rowsFor(markup, OWNER_ID)).toHaveLength(1);
  });
});

describe("MemberList: a viewer sees the members but no management controls", () => {
  const markup = renderToStaticMarkup(MemberList({ members, currentUserId: VIEWER_ID, myRole: "viewer" }));

  it("has no Verwalten button, no dialog, no share form, no \"Teilen\" button and no \"Entfernen\" button", () => {
    expect(markup).not.toMatch(/Verwalten/);
    expect(markup).not.toMatch(/<dialog\b/);
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
    expect(markup).not.toMatch(/Entfernen/);
    expect(markup).not.toMatch(/<select\b/);
  });

  it("still lists every member with a name and a role", () => {
    const text = textOf(markup);
    expect(text).toMatch(/\bDu\b/);
    expect(text).toContain("Betrachter");
    expect(text).toContain("Eigentümer");
  });
});

describe("MemberList: an owner viewing a co-owner's row", () => {
  // Owners are flat (AGENTS.md / ADR 0001 "co-owner" tests elsewhere): there
  // is no "demote/remove a fellow owner" action in this UI at all, so even
  // the viewing owner must see no role-change or remove control on another
  // member whose role is "owner" -- only on editor/viewer rows, and those only
  // inside the Verwalten dialog.
  const coOwnerId = "33333333-3333-4333-8333-333333333333";
  const membersWithCoOwner = [
    { userId: OWNER_ID, role: "owner" as const },
    { userId: coOwnerId, role: "owner" as const },
  ];
  const markup = renderToStaticMarkup(
    MemberList({ members: membersWithCoOwner, currentUserId: OWNER_ID, myRole: "owner" }),
  );

  it("renders no role-change control and no \"Entfernen\" button on any row of the co-owner, in the list or in the dialog", () => {
    const rows = rowsFor(markup, coOwnerId);
    expect(rows.length).toBeGreaterThan(0);
    for (const coOwnerRow of rows) {
      expect(coOwnerRow).not.toMatch(/Entfernen/);
      expect(extractOptionTags(coOwnerRow)).toEqual([]);
      // No form at all on this row -- not a role-change form, not a remove
      // form, not anything else: a co-owner's row is plain, unmanageable
      // display only.
      expect(coOwnerRow).not.toMatch(/<form/);
    }
  });

  it("still shows the co-owner's role as Eigentümer in visible text of the compact list", () => {
    expect(textOf(splitByDialog(markup).outside)).toContain("Eigentümer");
  });
});

describe("MemberList: an anonymous-signin owner gets no Verwalten", () => {
  // notebook_members_insert_not_anonymous (supabase/migrations/
  // 20261017120000_notebooks_memberships.sql) is a restrictive INSERT-only
  // policy: an anonymous-signin owner can never add a new member. Per the plan
  // for feat/notebook-layout only a non-anonymous owner gets the "Verwalten"
  // button and its dialog, so a demo user sees the compact list and nothing to manage.
  const markup = renderToStaticMarkup(
    MemberList({ members, currentUserId: OWNER_ID, myRole: "owner", isAnonymous: true }),
  );

  it("has no Verwalten button, no dialog, no \"Nutzer-ID\" field and no \"Teilen\" button, even though myRole is owner", () => {
    expect(markup).not.toMatch(/Verwalten/);
    expect(markup).not.toMatch(/<dialog\b/);
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
  });

  it("renders no management control anywhere, and still lists the members", () => {
    expect(markup).not.toMatch(/Entfernen/);
    expect(markup).not.toMatch(/<select\b/);
    expect(textOf(markup)).toContain(VIEWER_ID.slice(0, 8));
    expect(textOf(markup)).toMatch(/\bDu\b/);
  });
});
