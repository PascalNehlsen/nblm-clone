// MemberList renders a notebook's member rows and, per canManageMembers(),
// the owner-only management controls: the share form ("Nutzer-ID" field, a
// role select offering Bearbeiter/Betrachter, "Teilen" button) and a
// per-member "Entfernen" button. Editors and viewers must see the member
// list but none of those controls (AGENTS.md: "an editor cannot change
// roles"; this is the first line of defense, RLS is the second).
//
// Rendered with renderToStaticMarkup, same technique as
// tests/unit/web-shell.test.tsx (calling the component function directly,
// not through a JSX runtime that needs a browser/DOM).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberList } from "@/app/(app)/notebooks/[id]/member-list";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";

const members = [
  { userId: OWNER_ID, role: "owner" as const },
  { userId: VIEWER_ID, role: "viewer" as const },
];

/** Pulls out each rendered `<option ...>...</option>` segment, so a test can
 * check what a <select> actually offers without being tripped up by
 * "Eigentümer" legitimately appearing elsewhere in the markup as a member's
 * role label (the owner's own row must say "Eigentümer"; it must just never
 * be an offered, selectable role). */
function extractOptionTags(markup: string): string[] {
  return markup.match(/<option\b[^>]*>.*?<\/option>/gs) ?? [];
}

/** Returns the markup of the single <li> row for `userId`, so a test can
 * assert on what one specific member's row does or does not render without
 * being tripped up by another row (or the share form) containing the same
 * substrings ("Entfernen", an <option>, ...). Matched by the shortened
 * 8-character id prefix in the row's *visible* (tag-stripped) text, not the
 * full id: a row with no management controls (e.g. a co-owner's, viewed by
 * another owner) correctly has no hidden form inputs at all, so the full id
 * never appears in its markup -- only the shortened prefix every row shows.
 * Assumes a flat list (no nested <li>), which is all MemberList ever needs
 * to render. */
function extractListItemFor(markup: string, userId: string): string {
  const rows = markup.match(/<li>.*?<\/li>/gs) ?? [];
  const prefix = userId.slice(0, 8);
  const row = rows.find((candidate) => candidate.replace(/<[^>]+>/g, " ").includes(prefix));
  if (!row) throw new Error(`extractListItemFor: no <li> row found containing the shortened id "${prefix}"`);
  return row;
}

describe("MemberList: owner sees management controls", () => {
  const markup = renderToStaticMarkup(
    MemberList({ members, currentUserId: OWNER_ID, myRole: "owner" }),
  );

  it("renders the share form (a \"Nutzer-ID\" field and a \"Teilen\" button)", () => {
    expect(markup).toMatch(/Nutzer-ID/);
    expect(markup).toMatch(/Teilen/);
  });

  it("offers Bearbeiter (value \"editor\") and Betrachter (value \"viewer\") as roles, and never offers owner as a selectable option", () => {
    const options = extractOptionTags(markup);
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

  it("renders an \"Entfernen\" control for a member", () => {
    expect(markup).toMatch(/Entfernen/);
  });

  it("marks the current user's own row as \"Du\"", () => {
    expect(markup).toMatch(/\bDu\b/);
  });

  it("shows a shortened form of the other member's id, not the full uuid, in the visible text (hidden form fields legitimately carry the full id so the role-change/remove actions have something to submit)", () => {
    // Strip tags (and therefore their attributes, e.g. a hidden input's
    // value="<full-uuid>") so this only looks at what a user actually sees,
    // not at form plumbing.
    const visibleText = markup.replace(/<[^>]+>/g, " ");
    expect(visibleText).not.toContain(VIEWER_ID);
    expect(visibleText).toContain(VIEWER_ID.slice(0, 8));
  });
});

describe("MemberList: an editor sees the members but no management controls", () => {
  const markup = renderToStaticMarkup(
    MemberList({ members, currentUserId: VIEWER_ID, myRole: "editor" }),
  );

  it("has no share form, no \"Teilen\" button and no \"Entfernen\" button", () => {
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
    expect(markup).not.toMatch(/Entfernen/);
  });
});

describe("MemberList: a viewer sees the members but no management controls", () => {
  const markup = renderToStaticMarkup(
    MemberList({ members, currentUserId: VIEWER_ID, myRole: "viewer" }),
  );

  it("has no share form, no \"Teilen\" button and no \"Entfernen\" button", () => {
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
    expect(markup).not.toMatch(/Entfernen/);
  });
});

describe("MemberList: an owner viewing a co-owner's row", () => {
  // Owners are flat (AGENTS.md / ADR 0001 "co-owner" tests elsewhere): there
  // is no "demote/remove a fellow owner" action in this UI at all, so even
  // the viewing owner must see no role-change or remove control on another
  // member whose role is "owner" -- only on editor/viewer rows.
  const coOwnerId = "33333333-3333-4333-8333-333333333333";
  const membersWithCoOwner = [
    { userId: OWNER_ID, role: "owner" as const },
    { userId: coOwnerId, role: "owner" as const },
  ];
  const markup = renderToStaticMarkup(
    MemberList({ members: membersWithCoOwner, currentUserId: OWNER_ID, myRole: "owner" }),
  );

  it("renders no role-change control and no \"Entfernen\" button on the co-owner's own row", () => {
    const coOwnerRow = extractListItemFor(markup, coOwnerId);
    expect(coOwnerRow).not.toMatch(/Entfernen/);
    expect(extractOptionTags(coOwnerRow)).toEqual([]);
    // No form at all on this row -- not a role-change form, not a remove
    // form, not anything else: a co-owner's row is plain, unmanageable
    // display only.
    expect(coOwnerRow).not.toMatch(/<form/);
  });

  it("still shows the co-owner's role as Eigentümer in visible text", () => {
    const visibleText = markup.replace(/<[^>]+>/g, " ");
    expect(visibleText).toContain("Eigentümer");
  });
});

describe("MemberList: an anonymous-signin owner sees no share form", () => {
  // notebook_members_insert_not_anonymous (supabase/migrations/
  // 20261017120000_notebooks_memberships.sql) is a restrictive INSERT-only
  // policy: an anonymous-signin owner can still update/remove existing
  // members, just never add a new one -- so only the share form should
  // disappear here, not the per-member controls.
  const markup = renderToStaticMarkup(
    MemberList({ members, currentUserId: OWNER_ID, myRole: "owner", isAnonymous: true }),
  );

  it("has no \"Nutzer-ID\" field and no \"Teilen\" button, even though myRole is owner", () => {
    expect(markup).not.toMatch(/Nutzer-ID/);
    expect(markup).not.toMatch(/Teilen/);
  });

  it("still renders \"Entfernen\" for a non-owner member (only adding a member is blocked for an anonymous actor)", () => {
    expect(markup).toMatch(/Entfernen/);
  });
});
