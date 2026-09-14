/**
 * A reader that stops reading is not a crash.
 *
 * Measured: `tuplescope status | true`, `ls | true`, `--help | true` and
 * `run topup/happy | head -4` each died with `Error: write EPIPE`, an
 * unhandled 'error' event and a 25-line Node stack — the output of every
 * command, whenever the thing it was piped into had seen enough.
 *
 * A closed pipe is marked, and later writes to it are dropped: the command
 * finishes what it was doing and exits with its own code. It does not stop on
 * the spot, as a C tool killed by SIGPIPE would, because the work is not all
 * output. `run --junit out.xml | head -20` has a report file to write after
 * the lines `head` wanted, and a run history entry that `--from last` and
 * `keep` read; a run cut off between two steps would leave the backend half
 * driven with no record of what was sent. The exit code keeps meaning what it
 * documents — the verdict — rather than how much of the text was read.
 *
 * Any other write error is thrown, exactly as loudly as before: a full disk or
 * a dead terminal is not a reader that left.
 */

interface GuardedStream {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  write: (...args: never[]) => boolean;
}

const guarded = new WeakSet<object>();
const closed = new WeakSet<object>();

export function ignoreClosedPipes(
  streams: ReadonlyArray<GuardedStream> = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on('error', (error) => {
      if (error.code === 'EPIPE') {
        closed.add(stream);
        return;
      }
      throw error;
    });
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    (stream as { write: unknown }).write = (...args: unknown[]): boolean => {
      if (!closed.has(stream)) return write(...args);
      // Nobody is reading. A caller waiting on its callback still hears back,
      // and `true` means no one waits for a 'drain' that will never come.
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      if (callback) process.nextTick(callback);
      return true;
    };
  }
}
