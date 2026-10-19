import { signInWithGitHub } from "@/app/auth/actions";
import { DemoButton } from "./demo-button";
import { loginErrorMessage } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";

export const metadata = { title: "Anmelden" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const message = loginErrorMessage(params.fehler);
  const next = safeNextPath(params.next);

  return (
    <main>
      <h1>Anmelden</h1>
      {message ? <p role="status">{message}</p> : null}
      <form action={signInWithGitHub}>
        <input type="hidden" name="next" value={next} />
        <button type="submit">Mit GitHub anmelden</button>
      </form>
      <DemoButton siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} />
    </main>
  );
}
