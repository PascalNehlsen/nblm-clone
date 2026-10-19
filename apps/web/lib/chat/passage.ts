// Marks a cited quote inside its chunk (block D3). Only an exact substring is marked, so a
// forged quote in someone's own history is never highlighted as if it were in the source.
export function highlight(
  content: string,
  quote: string | null,
): { before: string; mark: string; after: string } | null {
  if (!quote) return null;
  const at = content.indexOf(quote);
  if (at === -1) return null;
  return { before: content.slice(0, at), mark: quote, after: content.slice(at + quote.length) };
}
