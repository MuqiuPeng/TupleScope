/**
 * Which stored run, if any, the page should be showing.
 *
 * Six lines, in their own file, because the version inlined in `app.js` was
 * wrong in a way its own comment described. It guarded against defaulting to a
 * run whose rows no longer matched the database — but only through a set that
 * fills on reset, and a page that has just loaded has reset nothing. So the one
 * case the guard was written for, a fresh load, was the one case it could not
 * reach.
 *
 * The runtime keeps its runs in memory and is long-lived; the one this was
 * found on had been up 27 hours. So `history[0]` is routinely from yesterday,
 * and the page opened on `Run clean · 2/2 steps · 14 pass` with green step
 * pills and a full change table, describing a database that had moved on.
 *
 * Loaded as a plain script before `app.js`, and required directly by its test.
 * Nothing here touches the DOM, which is the point.
 */
function chooseViewedRun({ history, viewedId, ranThisSession, resetHere }) {
  // An explicit choice wins over everything, reset or no reset: picking a run
  // out of the history control is a decision to look at it.
  const chosen = history.find((run) => run.id === viewedId);
  if (chosen) return chosen;

  const newest = history[0];
  if (!newest) return null;
  // Otherwise only a run this page produced. Everything older is one control
  // away, which is where choosing to look at it belongs.
  if (!ranThisSession.has(newest.id)) return null;
  // Ran, then put the database back: those rows were true of something that has
  // since been wiped, even though this page is what produced them.
  if (resetHere) return null;
  return newest;
}

if (typeof module !== 'undefined') module.exports = { chooseViewedRun };
