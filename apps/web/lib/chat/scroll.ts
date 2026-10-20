// The chat scrolls once per question: the new question moves to the top of the history and
// the answer is written below it without anything moving. The spacer after the content keeps
// at least one window of room below the question, so that scroll position stays valid while
// the answer is shorter than the window; once the answer outgrows it, the spacer is 0.
export function spacerHeight(anchorTop: number, clientHeight: number, contentBottom: number): number {
  const gap = anchorTop + clientHeight - contentBottom;
  return gap > 0 ? gap : 0;
}
