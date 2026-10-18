// Clicking "Mit GitHub anmelden" must send the browser to the *local*
// Supabase Auth authorize endpoint, never to a real network call, and never
// skip PKCE. Requests to github.com are aborted outright: this test must
// pass with zero egress to GitHub, since the local GitHub OAuth app has no
// real client secret.
import { expect, test } from "@playwright/test";
import { supabaseLocalConfig } from "../rls/helpers/clients";

test("GitHub sign-in starts at the local Supabase authorize endpoint and never reaches github.com", async ({
  page,
  context,
}) => {
  const { url: supabaseUrl } = supabaseLocalConfig();

  let reachedGithub = false;
  await context.route("**://github.com/**", async (route) => {
    reachedGithub = true;
    await route.abort();
  });

  await page.goto("/login");

  const authorizeRequestPromise = page.waitForRequest((request) => request.url().includes("/auth/v1/authorize"));
  await page.getByRole("button", { name: "Mit GitHub anmelden" }).click();
  const authorizeRequest = await authorizeRequestPromise;

  const authorizeUrl = new URL(authorizeRequest.url());
  expect(authorizeUrl.origin).toBe(new URL(supabaseUrl).origin);
  expect(authorizeUrl.pathname).toBe("/auth/v1/authorize");
  expect(authorizeUrl.searchParams.get("provider")).toBe("github");
  expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBeTruthy();

  const redirectTo = authorizeUrl.searchParams.get("redirect_to");
  expect(redirectTo).toBeTruthy();
  expect((redirectTo as string).startsWith("http://127.0.0.1:3000/auth/callback")).toBe(true);

  expect(reachedGithub).toBe(false);
});
