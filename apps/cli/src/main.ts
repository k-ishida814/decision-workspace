#!/usr/bin/env bun
import { run } from "./run";

const code = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
// `dw daemon run` resolves only after a signal; everything else exits right away.
process.exit(code);
