// Shared locators and steps for the notebook page's two management dialogs (plan
// feat/notebook-layout): the add-source dialog opened by the button "Quelle hinzufügen"
// and the members dialog opened by "Verwalten". Both are modal <dialog> elements, so a
// closed one is not in the accessibility tree and getByRole("dialog") finds only an open one.
// Everything here drives the real UI; nothing seeds through a back door.
import { expect, type Locator, type Page } from "@playwright/test";

export type SourceTab = "Text" | "PDF" | "Webseite";

/** The notebook page's "Quelle hinzufügen" opener button (only editors and owners have one). */
export function addSourceButton(page: Page): Locator {
  return page.getByRole("button", { name: "Quelle hinzufügen", exact: true });
}

/** The "Verwalten" opener button of the members panel (only non-anonymous owners have one). */
export function manageButton(page: Page): Locator {
  return page.getByRole("button", { name: "Verwalten", exact: true });
}

/** Opens the add-source dialog (or returns it when it is already open). */
export async function openAddSourceDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  if ((await dialog.count()) === 0) {
    await addSourceButton(page).click();
  }
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tablist", { name: "Art der Quelle" })).toBeVisible();
  return dialog;
}

/** Opens the add-source dialog, selects `tabName` and returns the form of the one visible panel. */
export async function openSourceForm(page: Page, tabName: SourceTab): Promise<Locator> {
  const dialog = await openAddSourceDialog(page);
  const tab = dialog.getByRole("tablist", { name: "Art der Quelle" }).getByRole("tab", { name: tabName, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const form = dialog.getByRole("tabpanel").locator("form");
  await expect(form).toHaveCount(1);
  return form;
}

/** Opens the members dialog (or returns it when it is already open). */
export async function openMembersDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  if ((await dialog.count()) === 0) {
    await manageButton(page).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The open confirmation dialog with this heading. Inside the members dialog the confirmation
 * is a second <dialog>, possibly nested in the first one's DOM; so "has this heading" alone
 * could match the outer dialog too. Only a dialog that contains no other open dialog counts.
 */
export function confirmDialog(page: Page, heading: string): Locator {
  return page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: heading }) })
    .filter({ hasNot: page.getByRole("dialog") });
}

/** Closes the one open dialog with Escape and waits until none is open. */
export async function closeDialogWithEscape(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** A visible element with this text. The members dialog keeps its member rows in the DOM
 * while closed, so a plain getByText can match twice; only the visible one counts. */
export function visibleText(page: Page, text: string): Locator {
  return page.getByText(text).filter({ visible: true });
}

/** The share form inside the open members dialog (it holds the "Nutzer-ID" field). */
export function shareForm(dialog: Locator): Locator {
  return dialog.locator("form").filter({ has: dialog.page().getByLabel("Nutzer-ID") });
}

/**
 * Shares the open notebook with `userId` through the members dialog, checks that the dialog
 * stays open and now lists the new member, and closes the dialog again with Escape.
 */
export async function shareViaDialog(page: Page, userId: string, roleLabel: "Bearbeiter" | "Betrachter"): Promise<void> {
  const dialog = await openMembersDialog(page);
  const form = shareForm(dialog);
  await form.getByLabel("Nutzer-ID").fill(userId);
  await form.getByLabel("Rolle").selectOption({ label: roleLabel });
  await form.getByRole("button", { name: "Teilen" }).click();
  await expect(dialog.getByText(userId.slice(0, 8)).filter({ visible: true })).toBeVisible();
  await closeDialogWithEscape(page);
  await expect(visibleText(page, userId.slice(0, 8))).toBeVisible();
}
